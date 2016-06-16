"use strict";

var logger = require("log4js").getLogger("invoiceBuilder"),
    VError = require("verror"),
    // _ = require("lodash"),
    moment = require("moment"),
    importerModule = require("./importer.js"),
    Invoice = importerModule.Invoice,
    PLANS = importerModule.Importer.PLANS;

require("moment-range");

var InvoiceBuilder = function() {

};

/* These constants are definitely company-specific and maybe should be refactored
 * out into config file. */

InvoiceBuilder.MONTHS_UNPAID_TO_CANCEL = 2;

InvoiceBuilder.PERSONAL = {"Personal Plus": 1};

InvoiceBuilder.RATE_TO_PLANS = {
    ANNUALFEE: PLANS.PRO_ANNUALLY,
    MONTHLYFEE: PLANS.PRO_MONTHLY,
    QUARTERLYFEE: PLANS.PRO_QUARTERLY
};

InvoiceBuilder.STORAGE_PRORATION_CREDIT = {
    "Additional Storage: 10GB -- Proration Credit": 1,
    "Extra storage: 500 GB -- Proration Credit": 1,
    "Additional Storage: 500GB -- Proration Credit": 1
};

InvoiceBuilder.STORAGE_PRORATION = {
    "Additional Storage: 10GB -- Proration": 1,
    "Extra storage: 500 GB -- Proration": 1,
    "Additional Storage: 500GB -- Proration": 1
};

InvoiceBuilder.CURRENCY = {
    // AQuA vs CSV Export
    USD: "USD", // "US Dollar": "USD",
    EUR: "EUR" // "Euro": "EUR"
};

InvoiceBuilder.USERS_ITEMS = {
    "Users": 1
};

InvoiceBuilder.USERS_PRORATION = {
    "Users -- Proration": 1
};

InvoiceBuilder.USER_PRORATION_CREDIT = {
    "Users -- Proration Credit": 1,
    "Personal Plus -- Proration Credit": 1
};

InvoiceBuilder.STORAGE_ITEMS = {
    "Extra storage: 500 GB": 1,
    "Additional Storage: 500GB": 1,
    "Additional Storage: 10GB": 1,
    "Initial 250 GB of storage": 1
};

InvoiceBuilder.DISCOUNTS = {
    "Initial Discount: 1 Year": 1,
    "Initial Discount: 1 Month": 1,
    "Initial Fixed Discount : 1 Month": 1,
    "Initial Fixed Discount : 1 Year": 1
};

InvoiceBuilder.getCurrency = function(zuoraCurrency) {
    var result = InvoiceBuilder.CURRENCY[zuoraCurrency];
    if (!result) {
        throw new VError("Unknown currency from Zuora: " + zuoraCurrency);
    }
    return result;
};

InvoiceBuilder.buildInvoice = function(invoiceNumber, invoiceItems, postedDate,
    dueDate, currency, itemAdjs, invoiceAdjs, creditAdjs, payments, refunds,
    plansById) {
    try {
        if (!postedDate) {
            throw new VError("postedDate " + postedDate);
        }
        if (!dueDate) {
            throw new VError("dueDate " + dueDate);
        }
        // TODO: Currency per account! If currency changes, this might be wrong.
        var invoice = new Invoice(
            invoiceNumber,
            moment.utc(postedDate),
            InvoiceBuilder.getCurrency(currency),
            moment.utc(dueDate)
        );

        InvoiceBuilder.addInvoiceItems(
            invoiceItems,
            invoice,
            itemAdjs,
            invoiceAdjs,
            creditAdjs,
            plansById
        );

        let totalPayments = InvoiceBuilder.addPayments(payments,
            invoice,
            "Payment");

        let totalRefunds = InvoiceBuilder.addPayments(refunds,
            invoice,
            "Refund");

        var totalCreditAdjusted = InvoiceBuilder.testCreditAdjustmentCorrect(invoice, creditAdjs, totalPayments, totalRefunds);

        //HACK: chartmogul doesn't allow partial refunds, let's ignore them :(
        //TODO: there are multiple cases when this can happen - can be an error, a late discount done wrong etc.
        InvoiceBuilder.removePartialRefunds(invoice, totalPayments, totalRefunds, totalCreditAdjusted);

        return invoice;
    } catch (error) {
        logger.debug(error.stack);
        throw new VError(error, "Couldn't build invoice " + invoiceNumber);
    }
};

InvoiceBuilder.removePartialRefunds = function(invoice, totalPayments, totalRefunds, totalCreditAdjusted) {
    if (totalPayments === 0 && totalRefunds === 0) {
        return; // nothing paid or refunded
    }

    var invoiceTotal = Math.round(invoice.line_items.reduce(
                        (prev, item) => prev + item.amount_in_cents, 0));

    if (invoiceTotal === totalPayments &&
        (totalPayments === totalRefunds || totalRefunds === 0) &&
        totalCreditAdjusted === 0) {
        return; // is paid and optionally refunded (both in full)
    }

    // partial refund => ignore
    var clearPayment = totalPayments - totalRefunds + totalCreditAdjusted;
    if (clearPayment !== 0 && clearPayment === invoiceTotal) {
        invoice.transactions = invoice.transactions.filter(t => t.type === "payment");
        return;
    }

    throw new VError("Unexpected payment case: invoiceTotal %d, totalPayments %d, totalRefunds %d, totalCreditAdjusted %d, clearPayment %d",
        invoiceTotal, totalPayments, totalRefunds, totalCreditAdjusted, clearPayment);
};


/**
 * Credit adjustment behaves as payment, it just doesn't go anywhere, so
 * it doesn't affect cashflow. But we should still check it's correct.
 * TODO: what with partially adjusted/paid/refunded invoices?
 */
InvoiceBuilder.testCreditAdjustmentCorrect = function(invoice, creditAdjs, totalPayments, totalRefunds) {
    let creditAdjusted = InvoiceBuilder.processCreditAdjustments(creditAdjs),
        invoiceTotal = Math.round(invoice.line_items.reduce(
                            (prev, item) => prev + item.amount_in_cents, 0)),
        successfulTransactions = invoice.transactions.filter((tr) => tr.result === "successful").length;

    if (creditAdjusted) {
        creditAdjusted = Math.round(-creditAdjusted * 100);
        if (totalPayments || totalRefunds) {
            //TODO: if we want correct cash flow in Chartmogul, we'd need to
            // split the invoice, because CM doesn't allow partial payment.
            logger.warn("Invoice has both payments/refunds and credit adjustment! Cashflow incorrect.");
            return creditAdjusted;
        }
        if (creditAdjusted !== invoiceTotal) {
            logger.debug("creditAdjusted !== invoiceTotal: %d !== %d", creditAdjusted, invoiceTotal);
            throw new VError("Credit adjusted, but not the same as invoice amount!");
        } else if(successfulTransactions) {
            throw new VError("Partially refunded/paid and credit adjusted!");
        }
    }
    return creditAdjusted;
};

/**
 * @param type Refund|Payment
 */
InvoiceBuilder.addPayments = function(zuoraPayments, invoice, type) {
    if (!zuoraPayments || !zuoraPayments.length) {
        return 0;
    }
    var total = 0;

    zuoraPayments.forEach(function (payment) {
        try {
            var p = payment[type];
            var transaction = {
                date: moment.utc(p.CreatedDate || p.RefundDate),
                type: type.toLowerCase(),
                result: p.Status === "Processed" ? "successful" : "failed",
                // because one payment number can be assigned to multiple invoices
                external_id: (type === "Payment" ? p.PaymentNumber : p.RefundNumber) + "-" + payment.Invoice.InvoiceNumber
            };

            if (transaction.result === "successful") {
                let amount;
                if (type === "Payment") {
                    amount = payment.InvoicePayment.Amount;
                } else if (type === "Refund") {
                    amount = (payment.RefundInvoicePayment || payment.CreditBalanceAdjustment).RefundAmount;
                }
                total += amount * 100; //for debug
            }

            invoice.addTransaction(transaction);
        } catch (error) {
            logger.trace(payment);
            throw new VError(error, "Invalid payment");
        }
    });

    return Math.round(total);
};

InvoiceBuilder.addInvoiceItems = function(invoiceItems, invoice, adjustments, invoiceAdjustments, creditAdjustments, planUuids) {

    // logger.trace("adjustments", adjustments);
    // logger.trace("invoiceAdjustments", invoiceAdjustments);
    // logger.trace("creditAdjustments", creditAdjustments);

    var processedAdjustments = InvoiceBuilder.processAdjustments(adjustments),
        adjustmentMap = processedAdjustments[0],
        itemAdjustmentAmountTotal = processedAdjustments[1],
        invoiceAdjustmentAmount = InvoiceBuilder.processInvoiceAdjustments(invoiceAdjustments),
        discountMap = InvoiceBuilder.processDiscounts(invoiceItems);

    var processedLineItems = InvoiceBuilder.itemsForInvoice(invoiceItems,
        invoiceAdjustmentAmount,
        discountMap,
        adjustmentMap,
        planUuids);

    logger.debug(adjustmentMap);
    InvoiceBuilder.testTotalOfInvoiceEqualsTotalOfLineItems( // runtime sanity check
        invoiceItems[0], processedLineItems, itemAdjustmentAmountTotal, invoiceAdjustmentAmount);

    InvoiceBuilder.cancelLongDueInvoices(invoiceItems[0], processedLineItems);

    processedLineItems
        .forEach(invoice.addLineItem.bind(invoice));

    return invoice;
};

// InvoiceBuilder.processNegativeItems = function(items, invoice) {
//     var positive = items.filter(function (lineItem) {
//         return lineItem.amount_in_cents >= 0;
//     });
//     items.filter(function (lineItem) {
//         return lineItem.amount_in_cents < 0;
//     }).forEach(function (negativeItem) {
//         var found = positive.find(item => negativeItem.subscription_external_id === item.subscription_external_id);
//         if (!found) {
//             logger.warn("Invoice %s has unmatched negative items!", invoice.external_id, negativeItem);
//             positive.push(negativeItem); // so this unmatched item gets in the result
//             return;
//         }
//         found.amount_in_cents += negativeItem.amount_in_cents;
//         found.quantity -= negativeItem.quantity;
//     });
//     return positive;
// };

InvoiceBuilder.testTotalOfInvoiceEqualsTotalOfLineItems = function (
    firstItem, items, itemAdjustmentAmountTotal, invoiceAdjustmentAmount) {
    var shouldBeTotal = Math.round((firstItem.Invoice.Amount + itemAdjustmentAmountTotal + invoiceAdjustmentAmount) * 100),
        total = items.reduce(function (prev, cur) {
            return prev + cur.amount_in_cents;
        }, 0);
    if (total !== shouldBeTotal) {
        logger.debug(items);
        logger.error("line items: %d, input: %d = (invoice amount: %d + item adj. total: %d + invoice adj. total: %d) * 100",
            total, shouldBeTotal, firstItem.Invoice.Amount, itemAdjustmentAmountTotal, invoiceAdjustmentAmount);

        throw new VError("Total of line items not the total of invoice!");
    }
};

/**
 * HACK: unpaid invoice more than X months -> cancel subscriptions.
 * Under normal circumstances such accounts should be dealt with by sales
 * retention process.
 */
InvoiceBuilder.cancelLongDueInvoices = function (firstItem, positiveItems) {
    if (firstItem.Invoice.Amount > 0 &&
            firstItem.Invoice.Balance > 0 &&
            moment().diff(moment.utc(firstItem.Invoice.DueDate), "month") >= InvoiceBuilder.MONTHS_UNPAID_TO_CANCEL &&
            !positiveItems[0].cancelled_at) {

        positiveItems.forEach(function (item) {
            item.cancelled_at = positiveItems
                .filter(i => i.amount_in_cents > 0)[0]
                .service_period_start;
        });
    }
};

//TODO: simplify filtering
InvoiceBuilder.itemsForInvoice = function(invoiceItems,
    invoiceAdjustmentAmount,
    discountMap, adjustmentMap, planUuids) {

    var users = [],
        storage = [],
        personal = [],
        proratedUsersCredit = [],
        proratedStorageCredit = [],
        proratedUsers = [],
        proratedStorage = [];

    invoiceItems
    .filter(item => item.InvoiceItem.ChargeAmount) // ignore 0 charges
    .forEach(function(item) {
        var name = item.InvoiceItem.ChargeName;
        if (name in InvoiceBuilder.USERS_ITEMS) {
            users.push(item);
        } else if (name in InvoiceBuilder.STORAGE_ITEMS) {
            storage.push(item);
        } else if (name in InvoiceBuilder.USER_PRORATION_CREDIT) {
            proratedUsersCredit.push(item);
        } else if (name in InvoiceBuilder.USERS_PRORATION) {
            proratedUsers.push(item);
        } else if (name in InvoiceBuilder.STORAGE_PRORATION_CREDIT) {
            proratedStorageCredit.push(item);
        } else if (name in InvoiceBuilder.STORAGE_PRORATION) {
            proratedStorage.push(item);
        } else if (name in InvoiceBuilder.PERSONAL) {
            personal.push(item);
        } else if (name in InvoiceBuilder.DISCOUNTS) {
            //do nothing
        } else {
            logger.debug(item);
            throw new VError("Unknown item type: " + name);
        }
    });

    return InvoiceBuilder.processItems(
        proratedUsers.concat(proratedStorage, users, personal, storage),
        proratedUsersCredit, proratedStorageCredit,
        {discountMap,
            adjustmentMap,
            planUuids,
            invoiceAdjustmentAmount
        });
};

InvoiceBuilder.checkItemSanity = function(item) {
    if (!item.InvoiceItem.ServiceStartDate) {
        throw new VError("ServiceStartDate " + String(item.InvoiceItem.ServiceStartDate));
    }
    if (!item.InvoiceItem.ServiceEndDate) {
        throw new VError("ServiceEndDate " + String(item.InvoiceItem.ServiceEndDate));
    }
    // if ((item.InvoiceItem.Quantity === 0 || item.InvoiceItem.UnitPrice === 0) && item.InvoiceItem.ChargeAmount !== 0) {
    //     logger.error(item);
    //     throw new VError("Charge should be 0!");
    // }
};

InvoiceBuilder.processItems = function(
    items, proratedUsersCredit, proratedStorageCredit, context) {

    var discountMap = context.discountMap,
        adjustmentMap = context.adjustmentMap,
        planUuids = context.planUuids;

    logger.trace(items.map(i=>i.InvoiceItem.ChargeName));
    var result = items
        // Cannot - because of downgrades to free
        //.filter(item => item.InvoiceItem.Quantity !== 0 && item.InvoiceItem.UOM !== 0)
        .map(item => {
            logger.trace("InvoiceItem.Id %s - %s...", item.InvoiceItem.Id, item.InvoiceItem.ChargeName);
            InvoiceBuilder.checkItemSanity(item);

            /* Use discounts, adjustments and invoice adjustments */
            var discount = (discountMap[item.InvoiceItem.Id] || 0) + (adjustmentMap[item.InvoiceItem.Id] || 0),
                amount = item.InvoiceItem.ChargeAmount + discount;

            logger.trace("discount %d, adjustment %d, invoiceAdjustmentAmount %d",
                discountMap[item.InvoiceItem.Id] || 0, adjustmentMap[item.InvoiceItem.Id] || 0, context.invoiceAdjustmentAmount || 0);

            // the storage is for free usually...
            //TODO: how to include storage? it's different kind of quantity, so it would screw the stats

            //HACK: Chartmogul doesn't allow start == end, also service intersection must be at least 1 day
            var start = moment.utc(item.InvoiceItem.ServiceStartDate),
                end = moment.utc(item.InvoiceItem.ServiceEndDate);
            if (start.isSame(end)) {
                end = moment.utc(end).add(1, "day").toDate().getTime();
                item.InvoiceItem.ServiceEndDate = end;
            }

            //TODO: refactor sections out into functions
            /* Use proration credits */
            var prorated = false,
                quantity = item.InvoiceItem.Quantity,
                credits = (item.InvoiceItem.ChargeName in InvoiceBuilder.USERS_PRORATION ||
                           item.InvoiceItem.ChargeName in InvoiceBuilder.USERS_ITEMS) ?
                            proratedUsersCredit : proratedStorageCredit;
            var index = credits.length - 1;
            while (index >= 0) {
                let credit = credits[index];

                //HACK: service intersection must be at least 1 day
                let creditStart = moment.utc(credit.InvoiceItem.ServiceStartDate),
                    creditEnd = moment.utc(credit.InvoiceItem.ServiceEndDate);
                if (creditStart.isSame(creditEnd)) { //change source data, but just once
                    credit.InvoiceItem.ServiceEndDate = moment.utc(end).add(1, "day").toDate().getTime();
                }

                if (credit.Subscription.Name !== item.Subscription.Name ||
                    !InvoiceBuilder.serviceIntersection(credit, item)) {
                    index--;
                    continue;
                }
                prorated = true; // amount & quantity = change/differential

                // yes, really! See INV00003933, INV00004009
                let discountOnProration = (discountMap[credit.InvoiceItem.Id] || 0) + (adjustmentMap[credit.InvoiceItem.Id] || 0);
                //we are subtracting from amount (credit is negative)
                logger.debug("Applying credit %d with discount %d and quantity %d",
                    credit.InvoiceItem.ChargeAmount, discountOnProration, item.InvoiceItem.Quantity);

                amount += (credit.InvoiceItem.ChargeAmount + discountOnProration);
                // this can result in negative quantity => prorated downgrade
                quantity -= credit.InvoiceItem.Quantity;

                credits.splice(index, 1);
                index--;
            }

            if (!prorated &&
                (item.InvoiceItem.ChargeName in InvoiceBuilder.USERS_PRORATION ||
                item.InvoiceItem.ChargeName in InvoiceBuilder.STORAGE_PRORATION)) {
                logger.warn("Couldn't find credit, but item is prorated! Invoice: %s", item.Invoice.InvoiceNumber);
            }

            /* Deal with invoice adjustments */

            if (context.invoiceAdjustmentAmount < 0) {
                discount -= amount;
            }

            // perfect match
            if (amount + context.invoiceAdjustmentAmount === 0) {
                context.invoiceAdjustmentAmount = 0;
                amount = 0;
            }

            // partial match
            if (Math.sign(amount) !== Math.sign(context.invoiceAdjustmentAmount)) {
                if (Math.abs(amount) > Math.abs(context.invoiceAdjustmentAmount)) {
                    amount += context.invoiceAdjustmentAmount;
                    context.invoiceAdjustmentAmount = 0;
                } else {
                    context.invoiceAdjustmentAmount += amount;
                    amount = 0;
                }
            }

            /* chartmogul number format = in cents, discount positive number */
            amount = Math.round(amount * 100);
            discount = Math.round(discount * -100);

            // if (!amount) {
            //     return;
            // }

            // compile line item for chartmogul
            return {
                type: "subscription",
                // for deleted subscriptions we can't get the right number
                subscription_external_id: item.Subscription.Name || item.Subscription.Id,
                plan_uuid: planUuids[InvoiceBuilder.RATE_TO_PLANS[item.InvoiceItem.AccountingCode]],
                service_period_start: start,
                service_period_end: end,
                amount_in_cents: amount, // in cents
                cancelled_at: InvoiceBuilder.getSubscriptionCanceledDate(item),
                prorated: prorated,
                quantity,
                //discount_code: undefined,
                discount_amount_in_cents: Math.round(discount),
                tax_amount_in_cents: item.InvoiceItem.TaxAmount,
                external_id: item.InvoiceItem.Id
            };

        })
        .filter(Boolean);

    result = result.concat(InvoiceBuilder.handleUnmatchedCredits(
                            proratedUsersCredit, proratedStorageCredit, context)
                        );

    return result;
};

/**
 * Let's suppose missing "Users" means => 0
 */
InvoiceBuilder.handleUnmatchedCredits = function(proratedUsersCredit, proratedStorageCredit, context) {
    var result = [];
    if (proratedUsersCredit.length) {
        var items = proratedUsersCredit.map(function(credit) {
            var copy = JSON.parse(JSON.stringify(credit));
            copy.InvoiceItem.ChargeName = "Users -- Proration";
            // this basically means this subscription has been downgraded to zero
            copy.InvoiceItem.ChargeAmount = 0;
            copy.InvoiceItem.Quantity = 0;
            copy.InvoiceItem.Id += "-a"; // so it doesn't match against discounts

            return copy;
        });
        result = result.concat(InvoiceBuilder.processItems(
            items, proratedUsersCredit, proratedStorageCredit, context)
        );
        //throw new VError("Unmatched user credit items: " + context.proratedUsersCredit.length);
    }
    if (proratedStorageCredit.length) {
        logger.debug(proratedStorageCredit);
        throw new VError("Unmatched storage credit items: " + proratedStorageCredit.length);
    }
    return result;
};

InvoiceBuilder.processAdjustments = function(adjustments) {
    var adjustmentMap = {};
    var itemAdjustmentAmountTotal = 0;
    if (adjustments && adjustments.length) {
        adjustments.forEach(function (adjustment) {
            var amount = adjustment.InvoiceItemAdjustment.Amount;
            if (adjustment.InvoiceItemAdjustment.Type !== "Charge") {
                amount = -amount;
            }
            itemAdjustmentAmountTotal += amount;
            adjustmentMap[adjustment.InvoiceItem.Id] = amount;
        });
    }
    return [adjustmentMap, itemAdjustmentAmountTotal];
};

InvoiceBuilder.processInvoiceAdjustments = function(invoiceAdjustments) {
    var invoiceAdjustmentAmount = 0;
    if (invoiceAdjustments && invoiceAdjustments.length) {
        invoiceAdjustments.forEach(function (invoiceAdjustment) {
            var amount = invoiceAdjustment.InvoiceAdjustment.Amount;
            if (invoiceAdjustment.InvoiceAdjustment.Type !== "Charge") {
                amount = -amount;
            }
            invoiceAdjustmentAmount += amount;
        });
    }
    return invoiceAdjustmentAmount;
};

/**
 * Zuora contains discounts as invoice items. They have a special type and contain
 * ID to which other item they are related, so in the web GUI they look like a "subitem".
 * @returns a map of discounts by ID of their respective items.
 */
InvoiceBuilder.processDiscounts = function(invoiceItems) {
    var discountMap = {};
    invoiceItems
        .filter(i => i.InvoiceItem.ChargeName in InvoiceBuilder.DISCOUNTS)
        .forEach(function (discount) {
            discountMap[discount.InvoiceItem.AppliedToInvoiceItemId] = discount.InvoiceItem.ChargeAmount;
        });

    return discountMap;
};

InvoiceBuilder.processCreditAdjustments = function(creditAdjustments) {
    var adjustments = 0;
    if (creditAdjustments && creditAdjustments.length) {
        creditAdjustments.forEach(function (creditAdjustment) {
            var amount = creditAdjustment.CreditBalanceAdjustment.Amount;
            if (creditAdjustment.CreditBalanceAdjustment.Type !== "Increase") {
                amount = -amount;
            }
            adjustments += amount;
        });
    }
    return adjustments;
};

/**
 * Either returns the cancellation date or checks, whether it could be
 * a deleted subscription with leftover invoice (Zuora support says this
 * shouldn't happen). It's a freaky state and we must guess something, so
 * let's suppose the subscription was cancelled at the end.
 * @returns when cancelled or undefined
 */
InvoiceBuilder.getSubscriptionCanceledDate = function(item) {
    if (item.Subscription.CancelledDate) {
        return moment.utc(item.Subscription.CancelledDate);
    } else {
        if (!item.Subscription.Name) {
            return moment.utc(item.InvoiceItem.ServiceEndDate);
        }
    }
};

InvoiceBuilder.serviceIntersection = function(a, b) {
    return InvoiceBuilder.rangeIntersection(
        a.InvoiceItem.ServiceStartDate, a.InvoiceItem.ServiceEndDate,
        b.InvoiceItem.ServiceStartDate, b.InvoiceItem.ServiceEndDate
    );
};

InvoiceBuilder.rangeIntersection = function(aStart, aEnd, bStart, bEnd) {
    var rangeA = moment.range(moment.utc(aStart), moment.utc(aEnd)),
        rangeB = moment.range(moment.utc(bStart), moment.utc(bEnd)),
        intersection = rangeA.intersect(rangeB);

    if (intersection) {
        return intersection.diff("days");
    } else {
        return 0;
    }
};

exports.InvoiceBuilder = InvoiceBuilder;
