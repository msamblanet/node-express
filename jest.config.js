const rv = require("@msamblanet/node-project-settings/base/jest.config.js");

// Modify any baseline settings for Jest here
rv.coverageThreshold = {
    global: {
        // @todo Currently setting coverage to 0% for now as we do not have test coverage on this module
        branches: 0,
        functions: 0,
        lines: 0,
        statements: 0,
    },
};

module.exports = rv;
