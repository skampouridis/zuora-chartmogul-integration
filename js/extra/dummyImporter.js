"use strict";

var logger = require("log4js").getLogger("importer"),
    Q = require("q"),
    fs = require("fs");

var Importer = function () {
    this.dataSource = null; // must be set later
};

Importer.PLANS = {
    GENERIC_ANNUALLY: "Generic Annually",
    GENERIC_MONTHLY: "Generic Monthly",
    GENERIC_QUARTERLY: "Generic Quarterly"
};

Importer.prototype.configure = function () {
    logger.debug("Configuring dummy client...");
};

var ignoreDirExists = err => {
    if (err.errno !== -17) {
        throw err;
    }
};

Importer.prototype.getDataSource = function(name) {
    logger.trace("getDataSource");
    return Q.all([Q.ninvoke(fs, "mkdir", "dump").catch(ignoreDirExists),
                  Q.ninvoke(fs, "mkdir", "dump/customers").catch(ignoreDirExists)])
                  .then(() => "fake_datasource_uuid_" + name);
};

Importer.prototype.dropAndCreateDataSource = function(name) {
    logger.trace("dropAndCreateDataSource");
    return "fake_datasource_uuid_" + name;
};

Importer.prototype.getDataSourceOrFail = function (name) {
    return "fake_datasource_uuid_" + name;
};

Importer.prototype.getOrCreateDataSource = function (name) {
    return "fake_datasource_uuid_" + name;
};

Importer.prototype._insertPlan = function(dataSourceUuid, name, p, u, id) {
    return {uuid: "fake_plan_uuid_" + name, external_id: id};
};

Importer.prototype.insertPlans = function (plans) {
    return Q.all(plans.map(
        p => this._insertPlan(this.dataSource, p.name, p.count, p.unit, p.externalId))
            /* These plans are necessary due to invoices with deleted subscriptions */
        .concat([this._insertPlan(this.dataSource, Importer.PLANS.GENERIC_ANNUALLY, 1, "year", Importer.PLANS.GENERIC_ANNUALLY),
          this._insertPlan(this.dataSource, Importer.PLANS.GENERIC_MONTHLY, 1, "month", Importer.PLANS.GENERIC_MONTHLY),
          this._insertPlan(this.dataSource, Importer.PLANS.GENERIC_QUARTERLY, 3, "month", Importer.PLANS.GENERIC_QUARTERLY)
      ]));
};

Importer.prototype.insertCustomers = function(array) {
    return Q.all(array.map(i => this._insertCustomer(i[0], i[1])));
};

Importer.prototype._insertCustomer = function(accountId, info) {
    return Q.ninvoke(fs, "writeFile",
                        "./dump/customers/" + accountId + ".json",
                        JSON.stringify(info, null, 2))
                        .then(() => {
                            return {uuid: "fake_customer_uuid_" + accountId,
                                     external_id: accountId};
                        });
};

Importer.prototype.insertInvoices = function(customerUuid, invoicesToImport) {
    if (!invoicesToImport.length) {
        return Q();
    }
    logger.debug("Saving invoices", invoicesToImport.map(invo => invo.external_id));
    return Q.all(invoicesToImport.map(
        invo => Q.ninvoke(fs, "writeFile",
                            "./dump/" + invo.external_id + ".json",
                            JSON.stringify(invo, null, 2))
    ));
};

exports.Invoice = require("chartmoguljs").import.Invoice;

exports.Importer = Importer;
