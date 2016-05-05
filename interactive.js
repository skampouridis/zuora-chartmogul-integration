/* eslint no-console: ["error", { allow: ["log"] }] */
var logger = require("log4js").getLogger(),
    Q = require("q"),
    prompt = require("prompt"),
    colors = require("colors/safe");

var InteractiveConsole = function(loader) {
    this.loader = loader;
};

InteractiveConsole.prototype.loop = function () {
    var self = this;

    return Q.ninvoke(prompt, "get", [{name: "zoql", message: "$"}])
        .then((input) => self.loader.zoqlRequest(input.zoql))
        .then((result) => self.show(result))
        .catch(function(issue){
            if (issue.message !== "canceled") {
                logger.error(issue);
            }
        })
        .then(() => this.loop());
};

InteractiveConsole.prototype.run = function () {
    if (this.loader.production) {
        prompt.message = colors.red("production");
    } else {
        prompt.message = colors.green("sandbox");
    }

    prompt.delimiter = "";
    prompt.start();
    return this.loop();
};

InteractiveConsole.prototype.show = function (jsonArray) {
    for (var i = 0; i < Math.min(jsonArray.length, 10); i++) {
        console.log(JSON.stringify(jsonArray[i], null, 2));
    }
    if (jsonArray.length === 0) {
        console.log("Query returned zero results.");
    } else if (jsonArray.length > 10) {
        console.log("Query returned " + jsonArray.length + " results in total.");
    }
    return jsonArray;
};

exports.InteractiveConsole = InteractiveConsole;
