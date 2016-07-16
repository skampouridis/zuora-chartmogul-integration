"use strict";

var logger = require("log4js").getLogger("pendingRefunds"),
    VError = require("verror"),
    _ = require("lodash"),
    moment = require("moment"),
    Invoice = require("./importer.js").Invoice,
    InvoiceBuilder = require("./invoiceBuilder.js").InvoiceBuilder;

var PendingRefunds = function() {

};

PendingRefunds.addHangingRefunds = function(pendingCBARefunds, invoicesToImport) {
    // sort without mutating original, iterate in reverse order
    var invoices = _.sortBy(invoicesToImport, "external_id").reverse();
    for (var i = 0; i < invoices.length; i++) {
        let invoice = invoices[i];
        let result = PendingRefunds.addRefundsFromStandaloneCBA(pendingCBARefunds, invoice);
        pendingCBARefunds = result[0];
        let additionalInvoice = result[1];
        if (additionalInvoice) {
            invoices.push(additionalInvoice);
        }
    }
    // we need to re-sort, since we possibly added some invoices and reverted order
    invoices = _.sortBy(invoices, "external_id");
    if (pendingCBARefunds && pendingCBARefunds.length) {
        throw new VError("Pending extra-invoice refunds " + JSON.stringify(pendingCBARefunds));
    }
    return invoices;
};

/**
 * Some credit balance adjustments are done outside of invoices.
 * It's not possible to match them directly, so let's match them heuristically
 * by date and amount.
 * Tries to match first adjustment to invoice by date.
 */
PendingRefunds.addRefundsFromStandaloneCBA = function(cbas, invoice) {
    if (!cbas || !cbas.length) {
        return [cbas];
    }
    const invoiceDateM = moment.utc(invoice.date),
        invoiceTotal = invoice.line_items.reduce(function (prev, cur) {
            return prev + cur.amount_in_cents;
        }, 0);

    if (invoiceTotal <= 0) { // can't refund an invoice that has 0 amount to be paid
        return [cbas];
    }
    /* Same date or later and same amount => matches */
    let found = cbas.find(cba => moment.utc(cba.CreditBalanceAdjustment.CreatedDate).isSameOrAfter(invoiceDateM));
    if (!found) {
        return [cbas];
    }

    logger.debug("Found extra-invoice refund %s from credit, attaching it to invoice %s.",
        found.Refund.RefundNumber, invoice.external_id);
    let refundedAmount = Math.round(found.CreditBalanceAdjustment.Amount * 100),
        filteredCbas = cbas.filter(cba =>
            cba.CreditBalanceAdjustment.Id !== found.CreditBalanceAdjustment.Id);

    // matches exactly => just add refund
    if (refundedAmount == invoiceTotal) {
        InvoiceBuilder.addPayments([found], invoice, "Refund");
        return [filteredCbas];

    // split invoice, because chartMogul doesn't support partial refund
    } else if (refundedAmount < invoiceTotal) {
        var newInvoice = PendingRefunds.splitInvoice(invoice, refundedAmount);
        InvoiceBuilder.addPayments([found], newInvoice, "Refund");
        return [filteredCbas, newInvoice];
     // split adjustment, because it is more than there's on the invoice
    } else {
        filteredCbas.push(PendingRefunds.splitAdjustment(invoice, refundedAmount, invoiceTotal, found));
        return [filteredCbas];
    }
};

/**
 * Splits invoice in two - the new one is refunded.
 * Mutates the invoice (deducts the refunded part).
 * TODO: how to deal with quantity?
 * @param refundedAmount: positive amount_in_cents
 * @returns the new invoice.
 */
PendingRefunds.splitInvoice = function(invoice, refundedAmount, date) {
    logger.debug("Splitting invoice %s: refunded %d", invoice.external_id, refundedAmount);

    /* Create new invoice for the refunded part */
    let newInvoice = new Invoice(JSON.parse(JSON.stringify(invoice)));

    /* Because removing shouldn't be duplicated. */
    newInvoice.line_items = newInvoice.line_items.filter(item => item.__amendmentType !== "RemoveProduct");

    if (newInvoice.line_items.length != 1) {
        logger.debug(invoice.line_items);
        throw new VError("Not yet implemented: multiple items in invoice " + invoice.external_id + " to be splitted!");
    }

    invoice.line_items[0].amount_in_cents = refundedAmount;
    newInvoice.line_items[0].amount_in_cents -= refundedAmount;

    if (date) { // split by non-overlapping time range
        newInvoice.line_items[0].service_period_end = date;
        invoice.line_items[0].service_period_start = moment.utc(date).add(1, "day").toDate();
    }

    /* New fake ID's must be unique! */
    var suffix = "-" + Math.round(Math.random() * 100);
    newInvoice.external_id += suffix;
    newInvoice.line_items.forEach(p => p.external_id += suffix);
    newInvoice.transactions.forEach(t => t.external_id += suffix);
    return newInvoice;
};

/**
 * Mutates invoice (adds refund) + returns the rest to be added later.
 */
PendingRefunds.splitAdjustment = function(invoice, refundedAmount, invoiceTotal, cba) {
    logger.debug("Splitting adjustment %s: %d - %d = %d",
        cba.Refund.RefundNumber, refundedAmount, invoiceTotal, refundedAmount - invoiceTotal);
    // make new object, not to mutate original
    let processNow = JSON.parse(JSON.stringify(cba)),
        processNext = JSON.parse(JSON.stringify(cba));
    /* New fake ID's must be unique! */
    processNow.Refund.RefundNumber += "a";
    processNext.Refund.RefundNumber += "b";
    processNow.CreditBalanceAdjustment.Amount = invoiceTotal/100; //refund only the part that belongs to this invoice
    processNext.CreditBalanceAdjustment.Amount -= invoiceTotal/100; // try to find where to put the rest next time
    InvoiceBuilder.addPayments([processNow], invoice, "Refund");
    return processNext;
};

exports.PendingRefunds = PendingRefunds;