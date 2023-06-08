/**
 * hitc_easy_sales_suitelet.ts
 * originally by Head in the Cloud Development, Inc.
 *
 * @NScriptName HITC Easy Sale Suitelet
 * @NScriptType Suitelet
 * @NApiVersion 2.1
 */

import {EntryPoints} from "N/types";
import email   = require('N/email');
import error   = require('N/error');
import file    = require('N/file');
import format  = require("N/format");
import log     = require('N/log');
import record  = require('N/record');
import runtime = require('N/runtime');
import search  = require('N/search');
import url     = require('N/url');

export function onRequest(context: EntryPoints.Suitelet.onRequestContext) {
  let   customerId         = '';
  let   configSettings     = configurationSettings(context.request.parameters, customerId);
  const paymentInstruments = runtime.isFeatureInEffect({ feature: 'paymentinstruments' });
  if (context.request.method == 'GET') {
    const itemRows = generateItems(configSettings.savedSearchId, configSettings.priceLevel);
    context.response.write(drawHTMLForm(configSettings, itemRows));
  } else {
    log.debug('POST', `Comment ${context.request.parameters['comments']}; company ${context.request.parameters['companyName']}.`);
    const customerId  = checkExistingCustomerRecord(context.request.parameters, configSettings, paymentInstruments);
    configSettings    = configurationSettings(context.request.parameters, customerId);
    const responseStr = createTransactionRecord(Number(customerId), context.request.parameters, configSettings);
    context.response.write(responseStr);
  }
}

/** Creates the form **/
function drawHTMLForm(configSettings: IConfigurationSettings, itemRows: string): string {
  let clientScriptURL = '';
  search.create({ type: 'file', filters: [['name', 'is', 'hitc_easy_sale_client.js']], columns: ['url'] }).run().each((result) => {
    clientScriptURL = result.getValue('url') as string;
    return false;
  });
  let selectOptions = `<option value="0"></option>`;
  search.create({ type: 'paymentmethod', filters: ['creditcard', 'is', 'T'], columns: ['name'] }).run().each(function (result) {
    selectOptions += `<option value="${result.id}">${result.getValue('name')}</option>`;
    return true;
  });
  return file.load(configSettings.htmlTemplate).getContents()
    .replace('{{clientScriptURL}}', `${clientScriptURL}&v=210324a`)
    .replace('{{selectOptions}}', selectOptions)
    .replace('{{companyName}}', configSettings.companyName)
    .replace('{{headerAddress}}', configSettings.headerAddress.replace(/\n/g, '<br />')) // [HITC-157]
    .replace('{{itemRows}}', itemRows)
    .replace('{{getCountryOptions}}', getCountryOptions())
    .replace('{{getStateOptions}}', getStateOptions())
}

/** Generates the items from the saved search **/
function generateItems(savedSearchId: string, priceLevel: string): string {
  let itemRows = '';
  let headerRow = '<tr>';
  const itemSearch = search.load({ id: savedSearchId });
  // Add price column
  const priceFieldId = priceLevel == '1' ? 'baseprice' : `price${priceLevel}`;
  const columnNames: string[] = [];
  const searchColumns = itemSearch.columns as search.Column[];
  for (const column of searchColumns) {
    columnNames.push(column.name);
  }
  if (!~columnNames.indexOf(priceFieldId)) itemSearch.columns = searchColumns.concat([search.createColumn({ name: priceFieldId, label: 'Price' })]);
  itemSearch.run().each((result) => {
    if (!itemRows) { // Then insert the header row
      headerRow += `<th>Order</th>`;
      headerRow += `<th>Quantity</th>`;
      result.columns.forEach((column) => {
        headerRow += `<th>${column.label}</th>`;
      });
      headerRow += '</tr>';
    }
    itemRows += '<tr>';
    itemRows += `<td><input type="checkbox" class="selected" name="selected_${result.id}" data-price="${result.getValue(priceFieldId)}"></td>`;
    itemRows += `<td><input type="number" class="quantity" name="quantity_${result.id}" min="1" max="50" placeholder="0"></td>`;
    result.columns.forEach((column) => {
      if (result.getValue(column) === false) {
        itemRows += `<td>No</td>`;
      } else if (result.getValue(column) === true) {
        itemRows += `<td>Yes</td>`;
      } else if (result.getText(column)) {
        const textValue = result.getText(column);
        if (~textValue.indexOf('media.nl')) { // If its a file, we are assuming its an image to be displayed
          itemRows += `<td><img height="50px" width="50px" alt="Image" src="${textValue}" /></td>`;
        } else {
          itemRows += `<td>${textValue}</td>`;
        }
      } else {
        itemRows += `<td>${result.getValue(column)}</td>`;
      }
    });
    itemRows += '</tr>';
    return true;
  });
  // Returning the table with the headers for each row
  return `
    <div class="container">
      <div class="row">
          <div class="col-sm-12 col-md-10 col-md-offset-1">
              <table class="table table-hover" id="items-table">
                  <thead>${headerRow}</thead>
                  <tbody>${itemRows}</tbody>
              </table>
          </div>
      </div>
    </div>
 `;
}

/** Checks for existing customer in NetSuite **/
function checkExistingCustomerRecord(parameters: { [name: string]: string }, configSettings: IConfigurationSettings, paymentInstruments: boolean): string {
  if (!parameters['custEmail']) return '';
  let customerId: string;
  const filters = [["email", "is", parameters['custEmail']], 'and', ['subsidiary', 'anyof', configSettings.subsidiaryId], 'and', ['isinactive', 'is', 'F']];
  const existingCustomerSearch = search.create({ type: 'customer', filters }).run().getRange({ start: 0, end: 1 });
  if (existingCustomerSearch.length > 0) {
    customerId = existingCustomerSearch[0].id;
    log.debug('checkExistingCustomerRecord',`Customer found: ${customerId}.`);
    checkAddressExists(customerId, parameters);
    if (!paymentInstruments) ensureCustomerHasLegacyCreditCard(customerId, parameters); // Add the card if it isn't there
  } else { // No customers returned in results, so create a new one
    log.debug('checkExistingCustomerRecord',`No customer found -> Creating new customer record...`);
    customerId = newCustomer(configSettings.subsidiaryId, configSettings.accountId, parameters, paymentInstruments);
    if (paymentInstruments) addNewPaymentInstrumentRecord(customerId, parameters); // Adds payment card for new customer if payment instruments is on
  }
  return customerId;
}

/** Adds address to the customer record **/
function addCustomerAddress(customer: record.Record, parameters: { [name: string]: string }) {
  const lineCount = customer.getLineCount({ sublistId: 'addressbook' });
  customer.selectLine({ sublistId: 'addressbook', line: lineCount });
  const addressRec = customer.getCurrentSublistSubrecord({ sublistId: 'addressbook', fieldId: 'addressbookaddress' });
  addressRec.setText({  fieldId: 'country', text:  parameters['addrCountry'] });
  addressRec.setValue({ fieldId: 'addr1',   value: parameters['addrLineOne'] });
  addressRec.setValue({ fieldId: 'addr2',   value: parameters['addrLineTwo'] });
  addressRec.setValue({ fieldId: 'city',    value: parameters['addrCity'] });
  addressRec.setValue({ fieldId: 'state',   value: parameters['addrStateCounty'] });
  addressRec.setValue({ fieldId: 'zip',     value: parameters['addrPostcode'] });
  addressRec.setValue({ fieldId: 'defaultbilling', value: true});
  try {
    customer.commitLine({ sublistId: 'addressbook' });
    log.debug('addCustomerAddress', `New address added successfully.`);
  } catch (e) {
    log.error('addCustomerAddress', `Could not save address record because: ${e.message}`);
  }
}

/** Checks if address exists on customer record, if not, adds it **/
function checkAddressExists(customerId: string, parameters: { [name: string]: string }) {
  const customerAddressSearch = search.create({
    type: 'customer',
    filters: [["address.address1", "is", parameters['addrLineOne']], "AND", ["internalid", "anyof", customerId]]
  }).run().getRange({ start: 0, end: 1 });
  if (customerAddressSearch.length == 0) {
    log.debug('checkAddressExists', `No address found for customer - adding new address to customer record...`);
    const existingCustomerRecord = record.load({ type: 'customer', id: customerId, isDynamic: true });
    addCustomerAddress(existingCustomerRecord, parameters);
    existingCustomerRecord.save({ ignoreMandatoryFields: true });
    log.debug('checkAddressExists', `Record updated and saved with new address`);
  } else {
    log.debug('checkAddressExists', `Address already exists - No need to add address to customer record.`);
  }
}

/** Looks for a matching credit card on record - adds card details to record if not found **/
function ensureCustomerHasLegacyCreditCard(customerId: string, parameters: { [name: string]: string }) {
  let creditCardNo = '';
  let existingCreditCardMatch = false;
  let expiryDateRecord;
  const cardNo = parameters['cardNo'];
  const inputtedFourDigits = cardNo.substring(cardNo.length - 4); // Last four digits of card entered on suitelet
  log.debug('ensureCustomerHasLegacyCreditCard', `Payment Instrument feature enabled = false`);
  const existingCustomer = record.load({ type: 'customer', id: customerId, isDynamic: true });
  for (let line = 0; line < existingCustomer.getLineCount({ sublistId: 'creditcards' }); line++) {
    const longCardNo = existingCustomer.getSublistValue({ sublistId: 'creditcards', fieldId: 'ccnumber', line }) as string;
    creditCardNo = longCardNo.substring(longCardNo.length - 4); // Last four digits of card on file
    const comparableExpireDate = expiryStringToDate(parameters['expireDate']);
    expiryDateRecord = existingCustomer.getSublistValue({ sublistId: 'creditcards', fieldId: 'ccexpiredate', line }) as string;
    if ((expiryDateRecord == String(comparableExpireDate)) && (creditCardNo == inputtedFourDigits)) {
      existingCreditCardMatch = true;
      break;
    }
  }
  if (!existingCreditCardMatch) {
    addLegacyCreditCard(existingCustomer, parameters);
    try {
      existingCustomer.save({ ignoreMandatoryFields: true });
    } catch (e) {
      log.error('ensureCustomerHasLegacyCreditCard', `Did not save card on record because: ${e.message}`);
    }
  }
}

/** Find or create a payment instrument */
function getPaymentInstrument(customerId: string, parameters: { [name: string]: string }): string {
  const cardNo = parameters['cardNo'];
  const inputtedFourDigits = cardNo.substring(cardNo.length - 4); // Last four digits of card entered on suitelet
  const filters = [[`formulanumeric: INSTR({mask}, ${inputtedFourDigits})`, 'greaterthan', '0'], "AND", ['customer', 'anyof', customerId], "AND", [`formulanumeric: INSTR({mask}, '${formatDateInSearch(parameters['expireDate'])}')`, 'greaterthan', '0']];
  log.debug('getPaymentInstrument', `Searching for existing payment instrument, customer ${customerId}, last four ${inputtedFourDigits}.`);
  let paymentCardId: string;
  const existingCardResults = search.create({ type: 'paymentinstrument', filters }).run().getRange({ start: 0, end: 1 });
  if (existingCardResults.length !== 0) {
    paymentCardId = existingCardResults[0].id;
    log.debug('getPaymentInstrument', `Existing payment instrument found - id: ${paymentCardId}.`);
  } else {
    log.debug('getPaymentInstrument', `No existing card found for customer in search - adding new payment instrument record`);
    paymentCardId = String(addNewPaymentInstrumentRecord(customerId, parameters));
  }
  return paymentCardId;
}

/** Creates the new customer **/
function newCustomer(subsidiaryId: string, accountId: string, parameters: { [name: string]: string }, paymentInstruments: boolean): string {
  const companyName = parameters['companyName'];
  const custName    = parameters['custName'];
  log.debug('newCustomer', `subsidiary ${subsidiaryId}, account ${accountId}, params: ${JSON.stringify(parameters)}.`);
  try {
    const customer = record.create({ type: 'customer', isDynamic: true });
    if (companyName) {
      customer.setValue({ fieldId: 'companyname', value: companyName });
    } else if (!companyName) {
      customer.setValue({ fieldId: 'isperson', value: 'T' });
      customer.setValue({ fieldId: 'firstname', value: custName });
    }
    customer.setValue({ fieldId: 'email',      value: parameters['custEmail'] });
    customer.setValue({ fieldId: 'subsidiary', value: subsidiaryId            });
    customer.setValue({ fieldId: 'comments',   value: parameters['comments']  });
    addCustomerAddress(customer, parameters);
    if (!paymentInstruments) addLegacyCreditCard(customer, parameters); // this one selects a line... might not work that way on this record
    const customerId = customer.save({ ignoreMandatoryFields: true });
    log.debug('newCustomer', `New customer record created with id: ${customerId} `);
    return String(customerId);
  } catch(e) {
    log.error('newCustomer',`Error creating new customer record: ${e.message}`);
  }
}

/** Creates either the Cash Sale or Sales Order transaction record **/
function createTransactionRecord(customerId: number, parameters: { [name: string]: string }, config: IConfigurationSettings): string {
  if (!customerId) return 'No customer - please ensure an email address was entered.'; // Someone managed to do a blank POST on 27 Jan 2022
  let createdTransactionId: number;
  let tranType: string;
  const transactionType = config.transactionType;
  if (transactionType == "Cash Sale") {
    tranType = 'cashsale';
  } else if (transactionType == 'Sales Order') {
    tranType = 'salesorder';
  }
  const transactionRec = record.transform({ fromId: Number(customerId), fromType: 'customer', toType: tranType, isDynamic: true });
  log.debug('createTransactionRecord', `Transforming customer record: ${customerId} to a ${transactionType} --> Setting payment card`);
  setPaymentCard(parameters, String(customerId), transactionRec, config.itemLocation, config.paymentProcessingProfile);
  transactionRec.setValue({ fieldId: 'location', value: config.itemLocation });
  search.load({ id: config.savedSearchId }).run().each((result) => {
    const selected = parameters[`selected_${result.id}`];
    const quantity = parameters[`quantity_${result.id}`];
    if (selected && quantity) {
      log.debug('createTransactionRecord', `Adding item ${result.id}, quantity ${quantity}.`);
      transactionRec.selectNewLine({ sublistId: 'item' });
      transactionRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',     value: result.id         });
      transactionRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: quantity          });
      transactionRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'price',    value: config.priceLevel });
      transactionRec.commitLine({ sublistId: 'item' });
    }
    return true;
  });

  const total = transactionRec.getValue('total');
  try {
    log.debug('createTransactionRecord', `Try saving ${transactionType} for customer ${customerId} subsidiary ${config.subsidiaryId}; Total ${total}.`);
    if (transactionType == 'Cash Sale') {
      if (~config.accountName.indexOf('Undeposited Funds')) {
        transactionRec.setValue('undepfunds', 'T'); // [HITC-156] This doesn't work, so we do a submitField below
      } else {
        transactionRec.setValue('account', config.accountId);
      }
    }
    createdTransactionId = transactionRec.save({ ignoreMandatoryFields: true });
    log.debug('createTransactionRecord', `${transactionType} created: ${createdTransactionId}.`);
    if (transactionType == 'Cash Sale' && ~config.accountName.indexOf('Undeposited Funds')) { // [HITC-156] This seems to be the only way to get it to undeposited funds :(
      record.submitFields({ type: 'cashsale', id: createdTransactionId, values: { undepfunds: true } });
    }
  } catch (e) {
    log.error('createTransactionRecord', `Error saving the ${transactionType}: ${e.message}`);
  }
  if (createdTransactionId) {
    sendEmailNotification(config, createdTransactionId);
    if (transactionType == 'Sales Order') {
      log.debug('Sales Order Success', `Showing Sales Order success page`);
      return salesOrderAccepted(config.companyLogo);
    } else if (transactionType == 'Cash Sale') {
      const paymentAuthorised = checkPaymentAuthorisation(createdTransactionId);
      if (paymentAuthorised || total == 0) {
        const transactionValues = search.lookupFields({ id: createdTransactionId, type: tranType, columns: ['tranid', 'fxamount', 'currency'] });
        const transactionNumber = transactionValues['tranid']   as string;
        const paymentTotal      = transactionValues['fxamount'] as string;
        const currencies        = transactionValues['currency'] as { text: string, value: string }[];
        const currencyId        = currencies[0].value;
        return transactionSuccessfulPage(config.companyLogo, createdTransactionId, transactionNumber, paymentTotal, currencyId);
      } else { // Transaction was created, but payment authorization failed
        log.debug('createTransactionRecord', `${transactionType} payment failed - deleting record and showing failed transaction page`);
        record.delete({ type: tranType, id: createdTransactionId });
        return transactionFailedPage(config.companyLogo);
      }
    }
  } else { // Transaction failed to create
    log.debug('createTransactionRecord', `Failed to create ${transactionType} transaction`);
    return transactionFailedPage(config.companyLogo);
  }
}

function sendEmailNotification(config: IConfigurationSettings, recordId: number): void {
  if (!config.emailAuthorId || !config.emailNotificationAddr) return;
  let recordURL = '';
  if (config.transactionType == 'Cash Sale')   recordURL = url.resolveRecord({ recordType: 'cashsale',   recordId });
  if (config.transactionType == 'Sales Order') recordURL = url.resolveRecord({ recordType: 'salesorder', recordId });
  let body = `Created ${config.transactionType || 'transaction'} ID ${recordId} successfully.`;
  if (recordURL) body += ` Click <a href="${recordURL}">here</a> to see the transaction in NetSuite.`;
  log.debug('sendEmailNotification', `Sending email for transaction ${recordId}, config: ${JSON.stringify(config)}.`)
  email.send({ author: Number(config.emailAuthorId), recipients: [config.emailNotificationAddr], subject: 'Easy Sale Order Created', body });
}

/** Adds payment card to customer payment based on if payment instruments are enabled or not **/
function setPaymentCard(parameters: { [name: string]: string }, customerId: string, transaction: record.Record, itemLocation: string, paymentProcessingProfile: string): void {
  const paymentInstrumentsEnabled = runtime.isFeatureInEffect({ feature: 'paymentinstruments' });
  if (paymentInstrumentsEnabled) {
    const paymentCard = getPaymentInstrument(customerId, parameters);
    log.debug('setPaymentCard', `Setting payment instrument ${paymentCard}.`);
    transaction.setValue({ fieldId: 'paymentoption',            value: paymentCard              });
    transaction.setValue({ fieldId: 'paymentcardcsc',           value: parameters['CVC']        });
    transaction.setValue({ fieldId: 'handlingmode',             value: 'PROCESS'                });
    transaction.setValue({ fieldId: 'paymentprocessingprofile', value: paymentProcessingProfile });
    // transaction.setValue({ fieldId: 'zipcode',                  value: parameters['addrPostcode']});
  } else { // Payment instruments is not enabled, so we use legacy card. We have already made sure it exists on the customer record.
    const cardNumber = parameters['cardNo'].replace(/ /g, '');
    log.debug('setPaymentCard', `Setting legacy card details on cashsale record`);
    transaction.setValue({ fieldId: 'paymentmethod',       value: parameters['cardType']     });
    transaction.setValue({ fieldId: 'ccexpiredate',        value: parameters['expireDate']   });
    transaction.setValue({ fieldId: 'ccname',              value: parameters['cardName']     });
    transaction.setValue({ fieldId: 'ccnumber',            value: cardNumber                 });
    transaction.setValue({ fieldId: 'ccsecuritycode',      value: parameters['CVC']          });
    transaction.setValue({ fieldId: 'ccstreet',            value: parameters['custAddress']  });
    transaction.setValue({ fieldId: 'creditcardprocessor', value: paymentProcessingProfile   });
    transaction.setValue({ fieldId: 'cczipcode',           value: parameters['addrPostcode'] });
    transaction.setValue({ fieldId: 'chargeit',            value: true                       });
    transaction.setValue({ fieldId: 'getauth',             value: true                       }); // Used on sales orders without payment instruments (okay to be checked in all scenarios)
  }
}

/** Check the payment went through on the Transaction **/
function checkPaymentAuthorisation(createdTransactionId: number): boolean {
  let authorizationResult = '', authorizationReason = '', captureResult = '', captureReason = '', amount = '', paymentAccepted: boolean;
  search.create({
    type: 'transaction',
    filters: [['mainline', 'is', 'T'], 'and', ['internalid', 'anyof', createdTransactionId]],
    columns: ['paymentEvent.paymenteventtype', 'paymentEvent.paymentstatus', 'paymentEvent.holdreason', 'paymentEvent.amount']
  }).run().each((result) => {
    const eventType   = result.getValue({ name: 'paymenteventtype', join: 'paymentEvent' }) as string;
    const eventStatus = result.getValue({ name: 'paymentstatus',    join: 'paymentEvent' }) as string;
    const reason      = result.getValue({ name: 'holdreason',       join: 'paymentEvent' }) as string;
    amount            = result.getValue({ name: 'amount',           join: 'paymentEvent' }) as string;
    log.debug('checkPaymentAuthorisation', `Event type found: ${eventType} for transaction ${createdTransactionId}.`);
    if (eventType == 'SALE') {
      authorizationResult = eventStatus; // 'ACCEPT' etc
      authorizationReason = reason;
    } else {
      captureResult = eventStatus;
      captureReason = reason;
    }
    return true;
  });
  log.debug('checkPaymentAuthorisation', `Amount: ${amount}, Auth result: ${authorizationResult}, Auth hold reason: ${authorizationReason}; Capture result: ${captureResult}, captureReason: ${captureReason}`);
  if (authorizationResult) {
    paymentAccepted = true;
    if (captureResult == 'Payment Hold' || (!captureResult && ~authorizationResult.toLowerCase().indexOf('hold'))) { // [HITC-156]
      log.debug('checkPaymentAuthorisation', `Payment ${createdTransactionId} is on hold.`);
      paymentAccepted = false;
    }
    const title = (captureResult ? `Capture Result` : 'Authorization Result') + ` - ${captureReason || authorizationReason}`;
    log.debug('checkPaymentAuthorisation', `${title} --> ${createdTransactionId} - Authorized ${amount}.`);
  } else {
    paymentAccepted = false;
  }
  log.debug('paymentAccepted', `${paymentAccepted}`);
  return paymentAccepted;
}

/** Adds a payment instrument record for customer **/
function addNewPaymentInstrumentRecord(customerId: string, parameters: { [name: string]: string }): number {
  try {
    const newPaymentCard = record.create({ type: 'paymentcard' });
    newPaymentCard.setValue({ fieldId: 'entity',              value: customerId });
    newPaymentCard.setValue({ fieldId: 'paymentmethod',       value: parameters['cardType'] });
    newPaymentCard.setValue({ fieldId: 'expirationdate',      value: format.parse({ type: format.Type.MMYYDATE, value: parameters['expireDate'] }) });
    newPaymentCard.setValue({ fieldId: 'nameoncard',          value: parameters['cardName']     });
    newPaymentCard.setValue({ fieldId: 'cardnumber',          value: parameters['cardNo']       });
    newPaymentCard.setValue({ fieldId: 'street',              value: parameters['custAddress']  });
    newPaymentCard.setValue({ fieldId: 'zipcode',             value: parameters['addrPostcode'] });
    const paymentCard = newPaymentCard.save({ ignoreMandatoryFields: true });
    log.debug('addNewPaymentInstrumentRecord', `New payment instrument record saved for customer ${customerId} - id: ${paymentCard}`);
    return paymentCard;
  } catch(e) { // If they enter an invalid card number, for example
    throw error.create({ name: e.name, message: e.message, notifyOff: true });
  }
}

/** Adds the payment details when payment instrument feature is false **/
function addLegacyCreditCard(customer: record.Record, parameters: { [name: string]: string }): void {
  customer.selectNewLine({ sublistId: 'creditcards' });
  customer.setCurrentSublistValue({ sublistId: 'creditcards', fieldId: 'paymentmethod',  value: parameters['cardType']                       });
  customer.setCurrentSublistValue({ sublistId: 'creditcards', fieldId: 'ccdefault',      value: true                                         });
  customer.setCurrentSublistValue({ sublistId: 'creditcards', fieldId: 'ccname',         value: parameters['cardName']                       });
  customer.setCurrentSublistValue({ sublistId: 'creditcards', fieldId: 'ccnumber',       value: parameters['cardNo']                         });
  customer.setCurrentSublistValue({ sublistId: 'creditcards', fieldId: 'ccexpiredate',   value: expiryStringToDate(parameters['expireDate']) });
  customer.commitLine({ sublistId: 'creditcards' });
  log.debug('addLegacyCreditCard', `Added new card to customer record.`);
}

/** Transaction success page **/
function transactionSuccessfulPage(companyLogo: string, createdTransactionId: number, transactionNumber: string, paymentTotal: string, currencyId: string): string {
  const currencySymbol = currencyLookUp(currencyId);
  log.debug('transactionSuccessfulPage', `tranID: ${transactionNumber}, paymentTotal: ${paymentTotal}, currency ${currencyId}`);
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Payment Successful</title>
        <style>
          #formContainer { padding-left: 20px; }
          #companyLogo { width: fit-content; height: fit-content; }
          * {
            font-family: Arial, Helvetica, sans-serif;
          }
        </style>
      </head>
      <body>
        <div id="formContainer">
          <span id="companyLogo"><img src="${companyLogo}" alt="Logo"></span>
          <h2>Order Confirmation</h2>
          <p id="referenceNo">Your payment amount of ${currencySymbol}${paymentTotal} has been accepted. Your transaction number is: ${transactionNumber}.</p>
        </div>
       </body>
    </html>
  `;
}

/** Transaction failed page **/
function transactionFailedPage(companyLogo: string): string {
  log.debug('Transaction Failed Page', `Transaction failed - showing failed page.`);
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Payment Failed</title>
        <style>
          #formContainer {padding-left: 20px;}
          #companyLogo { width: fit-content; height: fit-content; }
        </style>
      </head>
      <body>     
        <div id="formContainer">
          <span id="companyLogo"><img src="${companyLogo}" alt="Logo" /></span>
          <h2>Payment Failed</h2>
          <label><p id="referenceNo">Card payment failed to process.</p></label>
        </div>
       </body>
    </html>
  `;
}

/** Sales Order Accepted page **/
function salesOrderAccepted(companyLogo: string): string {
  log.debug('Sales Order created', `Showing the salesOrderAccepted page`);
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Payment Successful</title>
        <style>
          #formContainer { padding-left: 20px; }
          #companyLogo { width: fit-content; height: fit-content; }
          * {
            font-family: Arial, Helvetica, sans-serif;
          }
        </style>
      </head>
      <body>
        <div id="formContainer">
          <span id="companyLogo"><img src="${companyLogo}" alt="Company Logo"></span>
          <h2>Order Confirmation</h2>
          <p id="referenceNo">Sales order created successfully, thank you for your order!</p>
        </div>
       </body>
    </html>
  `;
}

/** Changes the expiry date from a string to Date object **/
function expiryStringToDate(expiry: string): Date { // Expects input to be like "10/2020"
  const monthYear = expiry.split('/');
  return new Date(`${monthYear[0]}/01/${monthYear[1]}`);
}

/** Drops the '0' in expire date for search filters **/
function formatDateInSearch(date: string): string {
  const firstNumber = date.charAt(0);
  if (firstNumber == '0') date = date.substring(1,7);
  return date;
}

/** Gets currency symbol from transaction **/
function currencyLookUp(currencyId: string): string {
  let currencySymbol = '';
  const currencyValues = search.lookupFields({ type: 'currency', id: currencyId, columns: ['symbol'] });
  if (~['AUD', 'CAD', 'USD'].indexOf(currencyValues['symbol'] as string)) {
    currencySymbol = "$";
  } else if (currencyValues['symbol'] == "EUR") {
    currencySymbol = "€";
  } else if ( currencyValues['symbol'] == "GBP") {
    currencySymbol = "£";
  }
  return currencySymbol;
}

/** Returns all of the configuration settings from the custom record **/
function configurationSettings( parameters: { [name: string]: string }, customerId: string): IConfigurationSettings {
  let filters: any[];
  let companyLogo = '';
  if (!customerId) {
    filters = [["custrecord_hitc_ess_default_config", "is", "T"], "AND", ['isinactive', 'is', 'F']];
  } else {
    log.debug('configurationSettings', `Using filters for configuration search with the customers subsidiary`);
    const customerSearch = search.lookupFields({ id: customerId, type: 'customer', columns: ['subsidiary'] });
    const subsidiary     = customerSearch['subsidiary'] as { text: string, value: string }[];
    const subsidiaryId   = subsidiary[0].value;
    filters = [['custrecord_hitc_subsidiary_ess', 'anyof', subsidiaryId], "AND", ['isinactive', 'is', 'F']];
  }
  log.debug('configurationSettings', `Filters for customer ${customerId}: ${JSON.stringify(filters)}.`);
  const results = search.create({
    type: 'customrecord_hitc_easy_sales_config',
    filters,
    columns: [
      'custrecord_hitc_pay_processing_file_ess',
      'custrecord_hitc_subsidiary_ess',
      'custrecord_hitc_company_logo_ess',
      'custrecord_hitc_name_ess',
      'custrecord_hitc_address_ess',
      'custrecord_hitc_account_ess',
      'custrecord_hitc_saved_search_ess',
      'custrecord_hitc_location_ess',
      'custrecord_hitc_notify_email_addr_ess',
      'custrecord_hitc_notify_email_author_ess',
      'custrecord_hitc_price_level_ess',
      'custrecord_hitc_tran_type_ess',
      'custrecord_hitc_html_template_ess'
    ]
  }).run().getRange({ start: 0, end: 1 });
  if (results.length > 0) {
    const configRecord             = results[0];
    const paymentProcessingProfile = configRecord.getValue('custrecord_hitc_pay_processing_file_ess') as string;
    const subsidiaryId             = configRecord.getValue('custrecord_hitc_subsidiary_ess')          as string;
    const companyName              = configRecord.getValue('custrecord_hitc_name_ess')                as string;
    let   headerAddress            = configRecord.getValue('custrecord_hitc_address_ess')             as string;
    headerAddress                  = headerAddress.replace(/\n/g, '<br>');
    const accountId                = configRecord.getValue('custrecord_hitc_account_ess')             as string;
    const accountName              = configRecord.getText('custrecord_hitc_account_ess');
    const savedSearchId            = configRecord.getValue('custrecord_hitc_saved_search_ess')        as string;
    const itemLocation             = configRecord.getValue('custrecord_hitc_location_ess')            as string;
    const emailNotificationAddr    = configRecord.getValue('custrecord_hitc_notify_email_addr_ess')   as string;
    const emailAuthorId            = configRecord.getValue('custrecord_hitc_notify_email_author_ess') as string;
    const priceLevel               = configRecord.getValue('custrecord_hitc_price_level_ess')         as string;
    const transactionType          = configRecord.getText('custrecord_hitc_tran_type_ess')            as string;
    const htmlTemplate             = configRecord.getValue('custrecord_hitc_html_template_ess')       as string;
    const companyLogoChoice        = configRecord.getValue('custrecord_hitc_company_logo_ess')        as string;
    if (companyLogoChoice) {
      const logoField = search.lookupFields({ type: 'file', id: companyLogoChoice, columns: ['url'] });
      companyLogo = logoField["url"] as string;
    }
    const config = { paymentProcessingProfile, subsidiaryId, companyLogo, companyName, headerAddress, accountId, accountName, savedSearchId, itemLocation, emailNotificationAddr, emailAuthorId, priceLevel, transactionType, htmlTemplate };
    log.debug('configurationSettings', `Using config ${results[0].id}: ${JSON.stringify(config)}.`); // [HITC-157]
    return config;
  } else {
    log.error('configurationSettings', `No configuration record found.`);
  }
}

/** Interface for the config settings **/
interface IConfigurationSettings {
  paymentProcessingProfile: string;
  subsidiaryId:             string;
  companyLogo:              string;
  companyName:              string;
  headerAddress:            string;
  accountId:                string;
  accountName:              string;
  savedSearchId:            string;
  itemLocation:             string;
  emailNotificationAddr:    string;
  emailAuthorId:            string;
  priceLevel:               string;
  transactionType:          string;
  htmlTemplate:             string;
}

function getCountryOptions(): string {
  return `
    <option value="0"></option>
    <option value="Afghanistan">Afghanistan</option>
    <option value="Albania">Albania</option>
    <option value="Algeria">Algeria</option>
    <option value="American Samoa">American Samoa</option>
    <option value="Andorra">Andorra</option>
    <option value="Angola">Angola</option>
    <option value="Anguilla">Anguilla</option>
    <option value="Antarctica">Antarctica</option>
    <option value="Antigua and Barbuda">Antigua and Barbuda</option>
    <option value="Argentina">Argentina</option>
    <option value="Armenia">Armenia</option>
    <option value="Aruba">Aruba</option>
    <option value="Australia">Australia</option>
    <option value="Austria">Austria</option>
    <option value="Azerbaijan">Azerbaijan</option>
    <option value="Bahamas">Bahamas</option>
    <option value="Bahrain">Bahrain</option>
    <option value="Bangladesh">Bangladesh</option>
    <option value="Barbados">Barbados</option>
    <option value="Belarus">Belarus</option>
    <option value="Belgium">Belgium</option>
    <option value="Belize">Belize</option>
    <option value="Benin">Benin</option>
    <option value="Bermuda">Bermuda</option>
    <option value="Bhutan">Bhutan</option>
    <option value="Bolivia">Bolivia</option>
    <option value="Bosnia and Herzegowina">Bosnia and Herzegowina</option>
    <option value="Botswana">Botswana</option>
    <option value="Bouvet Island">Bouvet Island</option>
    <option value="Brazil">Brazil</option>
    <option value="British Indian Ocean Territory">British Indian Ocean Territory</option>
    <option value="Brunei Darussalam">Brunei Darussalam</option>
    <option value="Bulgaria">Bulgaria</option>
    <option value="Burkina Faso">Burkina Faso</option>
    <option value="Burundi">Burundi</option>
    <option value="Cambodia">Cambodia</option>
    <option value="Cameroon">Cameroon</option>
    <option value="Canada">Canada</option>
    <option value="Cape Verde">Cape Verde</option>
    <option value="Cayman Islands">Cayman Islands</option>
    <option value="Central African Republic">Central African Republic</option>
    <option value="Chad">Chad</option>
    <option value="Chile">Chile</option>
    <option value="China">China</option>
    <option value="Christmas Island">Christmas Island</option>
    <option value="Cocos Islands">Cocos (Keeling) Islands</option>
    <option value="Colombia">Colombia</option>
    <option value="Comoros">Comoros</option>
    <option value="Congo">Congo</option>
    <option value="Congo">Congo, the Democratic Republic of the</option>
    <option value="Cook Islands">Cook Islands</option>
    <option value="Costa Rica">Costa Rica</option>
    <option value="Cota D'Ivoire">Cote d'Ivoire</option>
    <option value="Croatia">Croatia (Hrvatska)</option>
    <option value="Cuba">Cuba</option>
    <option value="Cyprus">Cyprus</option>
    <option value="Czech Republic">Czech Republic</option>
    <option value="Denmark">Denmark</option>
    <option value="Djibouti">Djibouti</option>
    <option value="Dominica">Dominica</option>
    <option value="Dominican Republic">Dominican Republic</option>
    <option value="East Timor">East Timor</option>
    <option value="Ecuador">Ecuador</option>
    <option value="Egypt">Egypt</option>
    <option value="El Salvador">El Salvador</option>
    <option value="Equatorial Guinea">Equatorial Guinea</option>
    <option value="Eritrea">Eritrea</option>
    <option value="Estonia">Estonia</option>
    <option value="Ethiopia">Ethiopia</option>
    <option value="Falkland Islands">Falkland Islands (Malvinas)</option>
    <option value="Faroe Islands">Faroe Islands</option>
    <option value="Fiji">Fiji</option>
    <option value="Finland">Finland</option>
    <option value="France">France</option>
    <option value="France Metropolitan">France, Metropolitan</option>
    <option value="French Guiana">French Guiana</option>
    <option value="French Polynesia">French Polynesia</option>
    <option value="French Southern Territories">French Southern Territories</option>
    <option value="Gabon">Gabon</option>
    <option value="Gambia">Gambia</option>
    <option value="Georgia">Georgia</option>
    <option value="Germany">Germany</option>
    <option value="Ghana">Ghana</option>
    <option value="Gibraltar">Gibraltar</option>
    <option value="Greece">Greece</option>
    <option value="Greenland">Greenland</option>
    <option value="Grenada">Grenada</option>
    <option value="Guadeloupe">Guadeloupe</option>
    <option value="Guam">Guam</option>
    <option value="Guatemala">Guatemala</option>
    <option value="Guinea">Guinea</option>
    <option value="Guinea-Bissau">Guinea-Bissau</option>
    <option value="Guyana">Guyana</option>
    <option value="Haiti">Haiti</option>
    <option value="Heard and McDonald Islands">Heard and Mc Donald Islands</option>
    <option value="Holy See">Holy See (Vatican City State)</option>
    <option value="Honduras">Honduras</option>
    <option value="Hong Kong">Hong Kong</option>
    <option value="Hungary">Hungary</option>
    <option value="Iceland">Iceland</option>
    <option value="India">India</option>
    <option value="Indonesia">Indonesia</option>
    <option value="Iran">Iran (Islamic Republic of)</option>
    <option value="Iraq">Iraq</option>
    <option value="Ireland">Ireland</option>
    <option value="Israel">Israel</option>
    <option value="Italy">Italy</option>
    <option value="Jamaica">Jamaica</option>
    <option value="Japan">Japan</option>
    <option value="Jordan">Jordan</option>
    <option value="Kazakhstan">Kazakhstan</option>
    <option value="Kenya">Kenya</option>
    <option value="Kiribati">Kiribati</option>
    <option value="Democratic People's Republic of Korea">Korea, Democratic People's Republic of</option>
    <option value="Korea">Korea, Republic of</option>
    <option value="Kuwait">Kuwait</option>
    <option value="Kyrgyzstan">Kyrgyzstan</option>
    <option value="Lao">Lao People's Democratic Republic</option>
    <option value="Latvia">Latvia</option>
    <option value="Lebanon">Lebanon</option>
    <option value="Lesotho">Lesotho</option>
    <option value="Liberia">Liberia</option>
    <option value="Libyan Arab Jamahiriya">Libyan Arab Jamahiriya</option>
    <option value="Liechtenstein">Liechtenstein</option>
    <option value="Lithuania">Lithuania</option>
    <option value="Luxembourg">Luxembourg</option>
    <option value="Macau">Macau</option>
    <option value="Macedonia">Macedonia, The Former Yugoslav Republic of</option>
    <option value="Madagascar">Madagascar</option>
    <option value="Malawi">Malawi</option>
    <option value="Malaysia">Malaysia</option>
    <option value="Maldives">Maldives</option>
    <option value="Mali">Mali</option>
    <option value="Malta">Malta</option>
    <option value="Marshall Islands">Marshall Islands</option>
    <option value="Martinique">Martinique</option>
    <option value="Mauritania">Mauritania</option>
    <option value="Mauritius">Mauritius</option>
    <option value="Mayotte">Mayotte</option>
    <option value="Mexico">Mexico</option>
    <option value="Micronesia">Micronesia, Federated States of</option>
    <option value="Moldova">Moldova, Republic of</option>
    <option value="Monaco">Monaco</option>
    <option value="Mongolia">Mongolia</option>
    <option value="Montserrat">Montserrat</option>
    <option value="Morocco">Morocco</option>
    <option value="Mozambique">Mozambique</option>
    <option value="Myanmar">Myanmar</option>
    <option value="Namibia">Namibia</option>
    <option value="Nauru">Nauru</option>
    <option value="Nepal">Nepal</option>
    <option value="Netherlands">Netherlands</option>
    <option value="Netherlands Antilles">Netherlands Antilles</option>
    <option value="New Caledonia">New Caledonia</option>
    <option value="New Zealand">New Zealand</option>
    <option value="Nicaragua">Nicaragua</option>
    <option value="Niger">Niger</option>
    <option value="Nigeria">Nigeria</option>
    <option value="Niue">Niue</option>
    <option value="Norfolk Island">Norfolk Island</option>
    <option value="Northern Mariana Islands">Northern Mariana Islands</option>
    <option value="Norway">Norway</option>
    <option value="Oman">Oman</option>
    <option value="Pakistan">Pakistan</option>
    <option value="Palau">Palau</option>
    <option value="Panama">Panama</option>
    <option value="Papua New Guinea">Papua New Guinea</option>
    <option value="Paraguay">Paraguay</option>
    <option value="Peru">Peru</option>
    <option value="Philippines">Philippines</option>
    <option value="Pitcairn">Pitcairn</option>
    <option value="Poland">Poland</option>
    <option value="Portugal">Portugal</option>
    <option value="Puerto Rico">Puerto Rico</option>
    <option value="Qatar">Qatar</option>
    <option value="Reunion">Reunion</option>
    <option value="Romania">Romania</option>
    <option value="Russia">Russian Federation</option>
    <option value="Rwanda">Rwanda</option>
    <option value="Saint Kitts and Nevis">Saint Kitts and Nevis</option> 
    <option value="Saint LUCIA">Saint LUCIA</option>
    <option value="Saint Vincent">Saint Vincent and the Grenadines</option>
    <option value="Samoa">Samoa</option>
    <option value="San Marino">San Marino</option>
    <option value="Sao Tome and Principe">Sao Tome and Principe</option> 
    <option value="Saudi Arabia">Saudi Arabia</option>
    <option value="Senegal">Senegal</option>
    <option value="Seychelles">Seychelles</option>
    <option value="Sierra">Sierra Leone</option>
    <option value="Singapore">Singapore</option>
    <option value="Slovakia">Slovakia (Slovak Republic)</option>
    <option value="Slovenia">Slovenia</option>
    <option value="Solomon Islands">Solomon Islands</option>
    <option value="Somalia">Somalia</option>
    <option value="South Africa">South Africa</option>
    <option value="South Georgia">South Georgia and the South Sandwich Islands</option>
    <option value="Span">Spain</option>
    <option value="SriLanka">Sri Lanka</option>
    <option value="St. Helena">St. Helena</option>
    <option value="St. Pierre and Miguelon">St. Pierre and Miquelon</option>
    <option value="Sudan">Sudan</option>
    <option value="Suriname">Suriname</option>
    <option value="Svalbard">Svalbard and Jan Mayen Islands</option>
    <option value="Swaziland">Swaziland</option>
    <option value="Sweden">Sweden</option>
    <option value="Switzerland">Switzerland</option>
    <option value="Syria">Syrian Arab Republic</option>
    <option value="Taiwan">Taiwan, Province of China</option>
    <option value="Tajikistan">Tajikistan</option>
    <option value="Tanzania">Tanzania, United Republic of</option>
    <option value="Thailand">Thailand</option>
    <option value="Togo">Togo</option>
    <option value="Tokelau">Tokelau</option>
    <option value="Tonga">Tonga</option>
    <option value="Trinidad and Tobago">Trinidad and Tobago</option>
    <option value="Tunisia">Tunisia</option>
    <option value="Turkiye">Türkiye</option>
    <option value="Turkmenistan">Turkmenistan</option>
    <option value="Turks and Caicos">Turks and Caicos Islands</option>
    <option value="Tuvalu">Tuvalu</option>
    <option value="Uganda">Uganda</option>
    <option value="Ukraine">Ukraine</option>
    <option value="United Arab Emirates">United Arab Emirates</option>
    <option value="United Kingdom">United Kingdom</option>
    <option value="United States">United States</option>
    <option value="United States Minor Outlying Islands">United States Minor Outlying Islands</option>
    <option value="Uruguay">Uruguay</option>
    <option value="Uzbekistan">Uzbekistan</option>
    <option value="Vanuatu">Vanuatu</option>
    <option value="Venezuela">Venezuela</option>
    <option value="Vietnam">Viet Nam</option>
    <option value="Virgin Islands (British)">Virgin Islands (British)</option>
    <option value="Virgin Islands (U.S)">Virgin Islands (U.S.)</option>
    <option value="Wallis and Futana Islands">Wallis and Futuna Islands</option>
    <option value="Western Sahara">Western Sahara</option>
    <option value="Yemen">Yemen</option>
    <option value="Serbia">Serbia</option>
    <option value="Zambia">Zambia</option>
    <option value="Zimbabwe">Zimbabwe</option>
  `;
}

function getStateOptions(): string {
  return `
    <option />
    <option value="AL">Alabama</option>
    <option value="AK">Alaska</option>
    <option value="AZ">Arizona</option>
    <option value="AR">Arkansas</option>
    <option value="CA">California</option>
    <option value="CO">Colorado</option>
    <option value="CT">Connecticut</option>
    <option value="DE">Delaware</option>
    <option value="DC">District Of Columbia</option>
    <option value="FL">Florida</option>
    <option value="GA">Georgia</option>
    <option value="HI">Hawaii</option>
    <option value="ID">Idaho</option>
    <option value="IL">Illinois</option>
    <option value="IN">Indiana</option>
    <option value="IA">Iowa</option>
    <option value="KS">Kansas</option>
    <option value="KY">Kentucky</option>
    <option value="LA">Louisiana</option>
    <option value="ME">Maine</option>
    <option value="MD">Maryland</option>
    <option value="MA">Massachusetts</option>
    <option value="MI">Michigan</option>
    <option value="MN">Minnesota</option>
    <option value="MS">Mississippi</option>
    <option value="MO">Missouri</option>
    <option value="MT">Montana</option>
    <option value="NE">Nebraska</option>
    <option value="NV">Nevada</option>
    <option value="NH">New Hampshire</option>
    <option value="NJ">New Jersey</option>
    <option value="NM">New Mexico</option>
    <option value="NY">New York</option>
    <option value="NC">North Carolina</option>
    <option value="ND">North Dakota</option>
    <option value="OH">Ohio</option>
    <option value="OK">Oklahoma</option>
    <option value="OR">Oregon</option>
    <option value="PA">Pennsylvania</option>
    <option value="RI">Rhode Island</option>
    <option value="SC">South Carolina</option>
    <option value="SD">South Dakota</option>
    <option value="TN">Tennessee</option>
    <option value="TX">Texas</option>
    <option value="UT">Utah</option>
    <option value="VT">Vermont</option>
    <option value="VA">Virginia</option>
    <option value="WA">Washington</option>
    <option value="WV">West Virginia</option>
    <option value="WI">Wisconsin</option>
    <option value="WY">Wyoming</option>`;
}
