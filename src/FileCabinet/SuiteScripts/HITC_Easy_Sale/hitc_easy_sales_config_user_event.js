/**
 * hitc_easy_sales_suitelet_user_event.ts
 * by Head in the Cloud Development, Inc.
 *
 * @NScriptName HITC Easy Sales Suitelet - User Event
 * @NScriptType UserEventScript
 * @NApiVersion 2.1
 */
define(["require", "exports", "N/ui/serverWidget"], function (require, exports, serverWidget) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.beforeSubmit = exports.beforeLoad = void 0;
    function beforeLoad(context) {
        if (context.type == context.UserEventType.CREATE || context.type == context.UserEventType.EDIT) {
            context.form.getField({ id: 'custrecord_hitc_pay_processing_file_ess' }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
            context.form.addField({ id: 'custpage_payment_profile', type: serverWidget.FieldType.SELECT, label: 'Payment Processing Profile', source: '-179' })
                .defaultValue = context.newRecord.getValue({ fieldId: 'custrecord_hitc_pay_processing_file_ess' });
        }
    }
    exports.beforeLoad = beforeLoad;
    function beforeSubmit(context) {
        const paymentProfileChoice = context.newRecord.getValue({ fieldId: 'custpage_payment_profile' });
        context.newRecord.setValue({ fieldId: 'custrecord_hitc_pay_processing_file_ess', value: paymentProfileChoice });
    }
    exports.beforeSubmit = beforeSubmit;
});
