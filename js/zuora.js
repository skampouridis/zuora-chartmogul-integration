"use strict";
const ZUORA_POLLING = 2000;

var logger = require("log4js").getLogger("zuora"),
    Q = require("q"),
    request = require("request-promise-any"),
    Converter = require("csvtojson").Converter;

/**
 * Handles retrieving export information from Zuora through AQuA API.
 * ZOQL in JSON REST. Transforms results into JSONs.
 */
var ZuoraAqua = function() {
    this.batchUri = "https://apisandbox.zuora.com/apps/api/batch-query/";
    this.fileUri = "https://apisandbox.zuora.com/apps/api/file/";

};

ZuoraAqua.prototype.configure = function(json) {
    logger.debug("Configuring Zuora client...");
    if (json.production) {
        this.production = json.production;
        this.batchUri = "https://www.zuora.com/apps/api/batch-query/";
        this.fileUri = "https://www.zuora.com/apps/api/file/";
    }
    this.auth = {
        user: json.username,
        pass: json.password
    };
    //this.zc = zuora.create(json);
};

/**
 * Gets CSV -> JSON. Doesn't stream, might eat memory (2x the file size),
 * but usually Zuora exports are just a few MB's.
 */
ZuoraAqua.prototype.retrieveFile = function(fileId) {
    var self = this;
    return request({
        method: "GET",
        uri: self.fileUri + fileId,
        json: true,
        auth: self.auth})
    .catch(err => {
        // logger.debug("retrieveFile", err);
        if (err.message === "Error: socket hang up") {
            logger.warn("Socket hang up, trying again, retrieveFile");
            return self.retrieveFile(fileId); // try again recursively
        } else {
            throw err;
        }
    });
};

ZuoraAqua.prototype.pollUntilReady = function(response){
    var jobId = response.id,
        name = response.name,
        self = this,
        deferred = Q.defer();

    if (!jobId || response.errorCode) {
        throw response;
    }

    var intervalId = setInterval(function(){
        logger.debug("Polling", name, jobId);
        request({
            method: "GET",
            uri: self.batchUri + "jobs/" + jobId,
            json: true,
            auth: self.auth})
        .then(function(job){
            //logger.debug(job)
            if (job.status === "completed") {
                clearInterval(intervalId);
                if (job.batches.length !== 1) {
                    throw new Error("Hey, this is not implemented! Multiple results: " + job.batches.length + ", job: " + job.id);
                }
                logger.info("Downloading %s", name);

                deferred.resolve(self.retrieveFile(job.batches[0].fileId));
            } else if (job.status === "aborted" || job.status === "cancelled") {
                clearInterval(intervalId);
                deferred.reject(job);
            } //pending/executing
        })
        .catch(err => {
            // logger.debug("pollUntilReady",err);
            if (err.message === "Error: socket hang up") {
                logger.warn("Socket hang up, trying again, pollUntilReady");
            } else {
                throw err;
            }
        });
    }, ZUORA_POLLING);

    return deferred.promise;
};

ZuoraAqua.prototype.zoqlRequest = function(query, name) {
    var self = this;
    return request({
        method: "POST",
        uri: this.batchUri,
        body: {
            useQueryLabels: true,
            format: "csv",
            name: name || "Chartmogul integration",
            dateTimeUtc: true,
            queries: [
                {name: "zoql",
                 type: "zoqlexport",
                 query}
            ]
        },
        json: true,
        auth: this.auth
    })
    .catch(err => {
        // logger.debug("zoqlRequest",err);
        if (err.message === "Error: socket hang up") {
            logger.warn("Socket hang up, trying again, zoqlRequest");
            return self.zoqlRequest(query, name); // try again recursively
        } else {
            throw err;
        }
    })
    .then(res => self.pollUntilReady(res))
     // Parsing needs to know headers in advance, because some lines might have empty columns.
    .then(buffer => Q.ninvoke(
        new Converter({headers: query.match(/select (.*) from.*/)[1].split(",")}),
        "fromString",
        buffer.toString())
    );
};

exports.ZuoraAqua = ZuoraAqua;
