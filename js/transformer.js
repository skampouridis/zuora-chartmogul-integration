"use strict";

var logger = require("log4js").getLogger("transformer"),
    Q = require("q"),
    _ = require("lodash"),
    moment = require("moment"),
    VError = require("verror"),
    InvoiceBuilder = require("./invoiceBuilder.js").InvoiceBuilder,
    PendingRefunds = require("./pendingRefunds.js").PendingRefunds;

/**
 * Uses loader and importer to manipulate I/O. Contains business logic of
 * changing zuora data into chartmogul data.
 */
var Transformer = function(loader, importer, cancellation) {
    this.loader = loader;
    this.importer = importer;
    this.cancellation = cancellation;

    this.includeFree = false;

    var customId = this.loader.customId;
    this.accountIdGetter = function(c) {return c.Account[customId] || c.Account.AccountNumber; };
};

/**
 * Main pipeline: fetches all Zuora data -> filters, covers special cases -> uploads.
 * TODO: @param differential boolean: false -> drop & complete reload of data
 * So far we've been unable to make differential updates because of retroactive changes.
 */
Transformer.prototype.run = function () {
    var self = this;
    return this.reloadAll()
                .spread(self.groupInsertPlansAndCustomers.bind(self))
                .spread(self.makeInvoices.bind(self));
};

Transformer.prototype.reloadAll = function () {
    logger.info("Importing data from Zuora...");

    return Q.all([
        this.loader.getAllInvoiceItems(),
        // not executed if includeFree !== true
        this.includeFree && this.loader.getAllCustomers(),
        this.loader.getAllPlans(),
        this.loader.getAllInvoicePayments(),
        this.loader.getAllRefundInvoicePayments()
            .catch(err => {
                logger.error("Couldn't fetch RefundInvoicePayments!", err);
                return []; // Zuora doesn't specify "No records" error. Recovery for that case.
            }),
        this.loader.getAllInvoiceItemAdjustments()
            .catch(err => {
                logger.error("Couldn't fetch InvoiceItemAdjustments!", err);
                return []; // Zuora doesn't specify "No records" error. Recovery for that case.
            }),
        this.loader.getAllInvoiceAdjustments()
            .catch(err => {
                logger.error("Couldn't fetch InvoiceAdjustments!", err);
                return []; // Zuora doesn't specify "No records" error. Recovery for that case.
            }),
        this.loader.getAllCreditBalanceAdjustments()
            .catch(err => {
                logger.error("Couldn't fetch CreditBalanceAdjustments!", err);
                return []; // Zuora doesn't specify "No records" error. Recovery for that case.
            }),
        this.importer.getDataSource(this.dataSource)
    ]);
};

Transformer.prototype.groupInsertPlansAndCustomers = function (
    invoices, customers, plans, payments, refunds, itemAdjs, invoiceAdjs, creditAdjs, dsUuid) {

    logger.info("Processing data...");

    var self = this;
    self.importer.dataSource = dsUuid;
    var itemsByAccount = self.filterAndGroupItems(invoices);

    creditAdjs = creditAdjs.filter(a => a.CreditBalanceAdjustment.Status === "Processed")
                            // exclude adjustments to excluded invoices
                           .filter(a => !self.excludeInvoices || !self.excludeInvoices.has(a.Invoice.InvoiceNumber));

    return Q.all([self.importer.insertPlans(this.transformPlans(plans))
                    .then(self.extIds2Uuids),
                  self.importCustomers(this.includeFree ? customers : itemsByAccount)
                    .then(self.extIds2Uuids),
                  itemsByAccount,
                  _.groupBy(payments,
                            p => p.Invoice.InvoiceNumber),
                  _.groupBy(refunds.filter(r => r.Refund.Status === "Processed"),
                            p => p.Invoice.InvoiceNumber),
                  _.groupBy(itemAdjs.filter(a => a.InvoiceItemAdjustment.Status === "Processed"),
                            p => p.Invoice.InvoiceNumber),
                  _.groupBy(invoiceAdjs.filter(a => a.InvoiceAdjustment.Status === "Processed"),
                            p => p.Invoice.InvoiceNumber),
                  _.groupBy(creditAdjs,
                            p => p.Invoice.InvoiceNumber),
                  _.groupBy(creditAdjs.filter(a => a.Refund.RefundNumber !== "" && a.Invoice.InvoiceNumber === ""),
                            self.accountIdGetter)
              ]);
};

/**
 * ProductRatePlanCharge joined to ProductRatePlan.
 * If there is a plan that has multiple billing periods, this is not going to work.
 */
Transformer.prototype.transformPlans = function(plans) {
    var checkMap = {};
    return plans
        .filter(p => p.ProductRatePlanCharge.BillingPeriod)
        .map(p => {
            var count, unit,
                planId = p.ProductRatePlan.Id,
                chargeId = p.ProductRatePlanCharge.Id,
                billing = p.ProductRatePlanCharge.BillingPeriod;

            switch (billing) {
            case "Month":
                count = 1, unit = "month";
                break;
            case "Quarter":
                count = 3, unit = "month";
                break;
            case "Semi-Annual":
                count = 6, unit = "month";
                break;
            case "Annual":
                count = 1, unit = "year";
                break;
            case "Eighteen Months":
                count = 18, unit = "month";
                break;
            case "Two Years":
                count = 2, unit = "year";
                break;
            case "Three Years":
                count = 3, unit = "year";
                break;
            case "Five Years":
                count = 5, unit = "year";
                break;
            case "Specific Months":
                count = 1, unit = "month";
                break;
            case "Subscription Term":
                logger.error(p);
                throw new VError("Plans with Subscription Term billing periods are currently unsupported!");
            case "Week":
                count = 7, unit = "day";
                break;
            case "Specific Weeks":
                count = 7, unit = "day";
                break;
            default:
                logger.error(p);
                throw new VError("Unknown plan billing period!");
            }

            if (checkMap[planId]) {
                if (billing !== checkMap[planId]) {
                    // charges are unique
                    return {name: p.ProductRatePlan.Name + " - " + billing,
                            externalId: chargeId,
                            count,
                            unit};
                }
                return; // skip duplicate
            } else {
                checkMap[planId] = billing;
            }

            return {name: p.ProductRatePlan.Name,
                    externalId: planId,
                    count,
                    unit};
        }).filter(Boolean);
};

Transformer.prototype.getCustomerUuid = function(customersById, accountId) {
    var customerUuid = customersById[accountId];
    if (!customerUuid) {
        logger.trace(JSON.stringify(customersById, null, 1));
        throw new VError("Missing customer UUID accountId: " + accountId);
    }
    return customerUuid;
};

/**
 * Two invoices after each other that cancel each other are actually not working in CM, must be removed.
 */
Transformer.prototype.removeAnnullingInvoices = function(invoices) {
    for (var i = 1; i < invoices.length; i++) {

        if (this.doInvoicesAnnul(invoices[i], invoices[i - 1])) {
            invoices.splice(i - 1, 2); // remove the two stupid invoices
        }
    }
    return invoices;
};

/**
 * Mostly concerned with term, money, plan and subscription. Not comparing quantity.
 */
Transformer.prototype.doInvoicesAnnul = function(a, b) {
    a = a.line_items;
    b = b.line_items;
    return a.reduce((prev, item) => prev + item.amount_in_cents, 0) ===
                -b.reduce((prev, item) => prev + item.amount_in_cents, 0) &&
        _.isEqual(new Set(a.map(i => i.subscription_external_id)),
                  new Set(b.map(i => i.subscription_external_id))) &&
        _.isEqual(new Set(a.map(i => i.service_period_start)),
                  new Set(b.map(i => i.service_period_start))) &&
        _.isEqual(new Set(a.map(i => i.service_period_end)),
                  new Set(b.map(i => i.service_period_end))) &&
        _.isEqual(new Set(a.map(i => i.plan_uuid)),
                  new Set(b.map(i => i.plan_uuid)));
};

/**
 * Invoices with only deleted subscriptions have to be removed.
 * Invoice with no effect should be removed.
 */
Transformer.prototype.removeNonsenseInvoices = function(invoices) {
    // any invoice containing deleted subscriptions must be removed
    return invoices.filter(invoice => invoice.line_items.every(
            line_item => line_item.subscription_external_id
        ))
        // invoice that has total 0 and doesn't change anything is pretty useless (and breaks CM)
        .filter(invoice => {

            var invoiceTotal = invoice.line_items.reduce((prev, item) => prev + item.amount_in_cents, 0),
                ii = invoice.line_items,
                sane = !(invoiceTotal === 0 &&
                    (new Set(ii.map(i => i.subscription_external_id))).size === 1 &&
                    (new Set(ii.map(i => i.service_period_start))).size === 1 &&
                    (new Set(ii.map(i => i.service_period_end))).size === 1 &&
                    (new Set(ii.map(i => i.plan_uuid))).size === 1 &&
                    (new Set(ii.map(i => Math.abs(i.quantity)))).size === 1);
            if (!sane) {
                logger.warn("Removing nonsense invoice: " + invoice.external_id);
            }
            return sane;
        });
};

/**
 * From all information available in Zuora creates Invoices compatible with
 * Chartmogul.
 */
Transformer.prototype.makeInvoices = function(
    plansById, customersById, itemsByAccount,
    paymentsByInvoice, refundsByInvoice, itemAdjsByInvoice,
    invoiceAdjsByInvoice, creditAdjsByInvoice, creditAdjsNoInvoiceByAccount) {

    var self = this,
        counter = 0;

    return Q.all(Object.keys(itemsByAccount)
        .map(function (accountId) {
            var invoices = _.groupBy(itemsByAccount[accountId], i => i.Invoice.InvoiceNumber);
            // remove items with deleted subscriptions
            Object.keys(invoices)
                .filter(invoNumber => invoices[invoNumber]
                    .every(item => !item.Subscription.Id))
                .forEach(invoNumber => delete invoices[invoNumber]);

            var customerUuid = self.getCustomerUuid(customersById, accountId);

            logger.debug("Processing accountId", accountId);

            var invoicesToImport = Object.keys(invoices)
                .sort() // sorts by keys, which are external_id and are growing with date
                .map(function (invoiceNumber) { // ordered processing
                    try {
                        logger.trace("Processing invoice", invoiceNumber);
                        var invoiceItems = invoices[invoiceNumber],
                            i = invoiceItems[0];

                        return InvoiceBuilder.buildInvoice(invoiceNumber,
                            invoiceItems,
                            i.Invoice.PostedDate,
                            i.Invoice.DueDate,
                            i.Account.Currency,
                            itemAdjsByInvoice[invoiceNumber],
                            invoiceAdjsByInvoice[invoiceNumber],
                            creditAdjsByInvoice[invoiceNumber],
                            paymentsByInvoice[invoiceNumber],
                            refundsByInvoice[invoiceNumber],
                            plansById
                        );

                    } catch (error) {
                        throw new VError(error, "Failed to process invoice " + invoiceNumber);
                    }
                })
                .filter(invoice => invoice.line_items.length);

            logger.trace("Invoices", invoicesToImport.map(i => i.external_id));

            try {
                var cbas = creditAdjsNoInvoiceByAccount[accountId] && creditAdjsNoInvoiceByAccount[accountId]
                                // I don't know, what to do with increases...
                                .filter(cba => cba.CreditBalanceAdjustment.Type === "Decrease");

                if (cbas && cbas.length) {
                    invoicesToImport = PendingRefunds.addHangingRefunds(cbas, invoicesToImport);
                }


                invoicesToImport = self.cancellation.cancelInvoices(invoicesToImport);

                /* Any two invoices for the same term, annulling each other can be omitted.
                 * It's after canceling, because that might be better way to deal with such invoices. */
                invoicesToImport = self.removeAnnullingInvoices(invoicesToImport);

                invoicesToImport = self.removeNonsenseInvoices(invoicesToImport);

                invoicesToImport = self.shiftDates(invoicesToImport);

            } catch(err) {
                throw new VError(err, "Failed to process account " + accountId);
            }
            /* Various checks */
            invoicesToImport
                .filter(invoice => invoice.line_items.some(line_item => !line_item.quantity))
                .forEach(invoice => {
                    logger.error(invoice);
                    throw new VError("Invoice can't have zero quantity!");
                });
            invoicesToImport
                .filter(invoice => invoice.line_items.some(line_item => !line_item.prorated && line_item.amount_in_cents < 0))
                .forEach(invoice => {
                    logger.error(invoice);
                    throw new VError("Invoice can't be unprorated with negative amount!");
                });
            invoicesToImport
                .filter(invoice => invoice.line_items.some(line_item => new Date(line_item.service_period_start) >= new Date(line_item.service_period_end)))
                .forEach(invoice => {
                    logger.error(invoice);
                    throw new VError("The service period start date must be before the end date.");
                });


            return self.importer.insertInvoices(customerUuid, invoicesToImport)
                .tap(() => {
                    if (!(++counter % 100)) {
                        logger.info("Processed %d customers.", counter);
                    }
                });

        }));
};

Transformer.prototype.configure = function (json) {
    if (!json) {
        return;
    }
    this.dataSource = json.dataSource || "zuora";
    if (json.accounts) {
        this.includeAccounts = json.accounts.include && new Set(json.accounts.include);
        this.excludeAccounts = new Set(json.accounts.exclude || []);
    }
    if (json.invoices) {
        this.excludeInvoices = new Set(json.invoices.exclude || []);
    }
    if (json.includeFree) {
        this.includeFree = true;
    }
};


/**
 * Groups by tenantId (AccountId field in Zuora) or Zuora Account ID.
 * Filters by include/exclude list. Removes FREE-only accounts (don't affect MRR).
 * @return map by accountId to array of items
 */
Transformer.prototype.filterAndGroupItems = function (invoiceItems) {
    var self = this;
    var itemsByAccountId = _.groupBy(invoiceItems
                .map(i => {
                    if (!i.Invoice || !i.Subscription) {
                        logger.error("This item doesn't have expected data!", i);
                        throw new VError("Missing data from Zuora!");
                    }
                    return i;
                })
                .filter(i => i.Invoice.Status === "Posted") //remove invoices that were canceled/just drafted
                .filter(i => i.InvoiceItem.AccountingCode !== "FREE") //remove free items
                .filter(i => !self.excludeInvoices || !self.excludeInvoices.has(i.Invoice.InvoiceNumber)), //remove blacklisted invoices
                        self.accountIdGetter);

    var filteredItemsByAccount = {};
    Object.keys(itemsByAccountId)
        .filter(accountId => itemsByAccountId[accountId]
            // remove never paying accounts
            .some(item => item.Invoice.Amount > 0))
        .filter(accountId => !this.includeAccounts || self.includeAccounts.has(accountId))
        .filter(accountId => !this.excludeAccounts || !self.excludeAccounts.has(accountId))
        .forEach(function (accountId) {
            filteredItemsByAccount[accountId] = itemsByAccountId[accountId];
        });
    return filteredItemsByAccount;
};

/**
 * HACK: Chartmogul can't process two events at the same second!
 */
Transformer.prototype.shiftDates = function(invoices) {
    // cache of dates for one account's invoices
    var seenDates = {};

    function shifter(i, field) {
        if (i[field]) {
            var date = moment.utc(i[field]),
                str = date.toISOString();
            if (seenDates[str]) {
                i[field] = moment.utc(date).add(seenDates[str]++, "second").toDate();
            } else {
                seenDates[str] = 1;
            }
        }
    }

    invoices.forEach(inv => { // invoices must be sorted by issue time = external_id!
        inv.line_items.forEach(i => {
            shifter(i, "service_period_start");
            shifter(i, "cancelled_at");
        });
    });
    return invoices;
};

/**
 * Uses the BillToContact pre-joined info to load necessary customers.
 * Depends on which InvoiceItems have been filtered.
 * Can process grouped items or array of customers, depending on settings.
 * @param customers - either array of InvoiceItems with pre-joined Account info OR
 *                    result of groupBy accountId with Account information.
 * @returns promise for all customers insertion
 */
Transformer.prototype.importCustomers = function (customers) {
    var self = this;
    if (Array.isArray(customers)) {
        return self.importer.insertCustomers(
            customers.filter(c => c.Account.Name)
                .filter(self.accountIdGetter)
                .map(c => [self.accountIdGetter(c), c])
            );
    } else {
        return self.importer.insertCustomers(Object.keys(customers)
            // not filtering by name, because if we can't import someone with an invoice, that's an important error
            .map(accountId => [accountId, customers[accountId][0]]));
    }
};

/* Helper functions */

/**
 * @param array - objects from Chartmogul response
 * @returns map[external id] -> uuid
 */
Transformer.prototype.extIds2Uuids = function (array) {
    var map = {};
    array.forEach(function (item) {
        map[item.external_id] = item.uuid;
    });
    return map;
};

exports.Transformer = Transformer;
