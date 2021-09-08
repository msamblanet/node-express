import * as Lib from "../src/index";
import LibDefault from "../src/index";

test("Verify exports", () => {
    expect(Lib.ExpressApplication).not.toBeNull();

    expect(LibDefault).toEqual(Lib.ExpressApplication);
});
