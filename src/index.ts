import express from "express";
import { ExpressTracker, ExpressTrackerMetadata, RequestTrackerRequest } from "@msamblanet/node-request-tracker";
import type { ServeStaticOptions } from "serve-static";
import { URL } from "url";
import http from "http";
import { AddressInfo } from "net";
import ngrok from "ngrok";
import type { RequestTrackerConfigOverride } from "@msamblanet/node-request-tracker";
import { Config, Override, BaseConfigurable } from "@msamblanet/node-config-types";
import type { Ngrok } from "ngrok";
import { HttpTerminator, createHttpTerminator } from 'http-terminator';
import { randomUUID } from "crypto";
import { Logger } from "tslog";

export interface ExpressApplicationConfig extends Config {
    baseUrl: string,
    tracker?: RequestTrackerConfigOverride
    useNgrok?: boolean|"true",
    ngrok?: Ngrok.Options
    terminator?: {
        gracefulTerminationTimeout?: number // Milliseconds
    },
    staticRoot?: string
    staticConfig?: ServeStaticOptions
}
export type ExpressApplicationConfigOverride = Override<ExpressApplicationConfig>;

export class ExpressApplication<X extends ExpressTrackerMetadata = ExpressTrackerMetadata> extends BaseConfigurable<ExpressApplicationConfig> {
    public static readonly DEFAULT_CONFIG: ExpressApplicationConfig = {
        baseUrl: "http://localhost:0", // port 0 means pick an unused port
        useNgrok: false,
        terminator: {
            gracefulTerminationTimeout: 10000
        },
        staticRoot: "./public"
    };

    public readonly app = express();
    public readonly topLevelRouter = express.Router();
    public readonly expressTracker: ExpressTracker;
    public readonly baseUrl: URL;
    public localUrl?: URL;
    public ngrokUrl?: URL;
    public ngrokApiUrl?: URL;
    public publicUrl?: URL;
    public shutdownToken?: string;
    protected state: "stopped"|"starting"|"started"|"stopping"|"error" = "stopped"
    protected server?: http.Server;
    protected httpTerminator?: HttpTerminator;
    protected log: Logger;

    public constructor(log: Logger, ...config: ExpressApplicationConfigOverride[]) {
        super(ExpressApplication.DEFAULT_CONFIG, ...config);
        this.log = log;

        this.baseUrl = new URL(this.config.baseUrl);
        this.expressTracker = new ExpressTracker(this.config.tracker);

        if (this.baseUrl.protocol !== "http:") throw new Error("Only http: protocol supported at this time");

        //
        // Setup the top level app
        //
        this.app.use(this.expressTracker.expressMiddleware as express.RequestHandler);
        this.app.use(this.baseUrl.pathname, this.topLevelRouter);
        this.app.use(this.notFoundMiddleware);
        this.app.use(this.errorHandlerMiddleware as express.ErrorRequestHandler);

        //
        // Setup static file serving
        //
        if (this.config.staticRoot) this.topLevelRouter.use(express.static(this.config.staticRoot, this.config.staticConfig));

        //
        // Setup the ping target on the top level router
        //
        this.topLevelRouter.use("/_ping", this.pingMiddleware); // Simple ping command
    }

    protected pingMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
        try {
            res.json({ping: true});
        } catch (err) {
            next(err);
        }
    }

    protected notFoundMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
        try {
            this.log.warn("404 on express request:", req.url);
            res.status(404).json({code: 404, msg: "Not Found", url: req.url});
        } catch (err) {
            next(err);
        }
    }

    protected errorHandlerMiddleware(err: unknown, req: RequestTrackerRequest<X>, res: express.Response, next: express.NextFunction): void {
        try {
            this.log.error("Error in express request:", req.url, err);

            // Stash error details...
            if (typeof err === "string" || err instanceof String) req.expressTrackerMetadata.error = err;
            else if (err instanceof Error) {
                req.expressTrackerMetadata.error = {
                    message: err.message,
                    code: (err as any).code, // eslint-disable-line @typescript-eslint/no-explicit-any
                    stack: err.stack
                };
            }
            res.status(500).json({code: 500, msg: "Unexpected Server Error", url: req.url });
        } catch (err) {
            next(err);
        }
    }

    public readonly shutdownMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
        try {
            if (!req.query["token"]) {
              res.json({ verify: `?token=${this.shutdownToken}` });
            } else if (req.query["token"] !== this.shutdownToken) {
                res.statusMessage = "Invalid Token";
                res.status(403).send();
            } else {
                this.stop().catch((err) => {
                    this.log.error("Error in shutdown:", err);
                });
                res.json({ "msg": "Shutdown initiated" });
            }
        } catch (err) {
            next(err);
        }
    }

    public addModule(path: string): express.Router {
        const rv = express.Router();
        this.topLevelRouter.use(path, rv);
        return rv;
    }

    protected async listen(): Promise<http.Server> {
        return await new Promise((resolve, reject) => {
            this.log.debug("Requesting listen on:", this.baseUrl);
            this.server = this.app.listen({
                port: this.baseUrl.port,
                host: this.baseUrl.hostname
            }, () => resolve(this.server as http.Server));
            this.httpTerminator = createHttpTerminator({ server: this.server as http.Server });
            this.server.once("error", reject);
        });
    }

    protected async startNgrok(): Promise<void> {
        this.log.debug("Starting ngrok");
        this.ngrokUrl = new URL(await ngrok.connect({ ...this.config.ngrok, proto: this.localUrl?.protocol.slice(0,-1) as Ngrok.Protocol, addr: this.localUrl?.port }));
        this.publicUrl = new URL(this.baseUrl.pathname, this.ngrokUrl);
        this.ngrokApiUrl = new URL(ngrok.getUrl() as string);
    }

    protected async stopNgrok(): Promise<void> {
        await ngrok.disconnect(this.ngrokUrl?.toString().slice(0,-1));
    }

    public async start(): Promise<void> {
        if (this.state !== "stopped") throw new Error(`Cannot start from state: ${this.state}`)
        this.state = "starting";

        try {
            this.server = await this.listen();

            const address = (this.server.address() as AddressInfo);
            const port = address.port ?? 80;
            this.publicUrl = this.localUrl = new URL(this.baseUrl.pathname, `${this.baseUrl.protocol}//${address.address}:${port}`);

            if (this.config.useNgrok === true || this.config.useNgrok === "true") await this.startNgrok();

            this.state = "started"
            this.shutdownToken = randomUUID();

        } catch (err) {
            this.state = "error";
            throw err;
        }
    }

    public async stop(): Promise<void> {
        if (this.state !== "started") throw new Error(`Cannot stop from state: ${this.state}`)
        this.state = "stopping";

        try {
            // Wait for in-flight requests to finish
            this.log.debug("Stopping Express");
            await this.httpTerminator?.terminate();

            // Terminate ngrok if needed
            this.log.debug("Stopping ngrok");
            if (this.ngrokUrl) await this.stopNgrok();

            this.log.debug("Express stopped");

            this.state = "stopped";
        } catch (err) {
            this.state = "error";
            throw err;
        }
    }
}

export default ExpressApplication;
