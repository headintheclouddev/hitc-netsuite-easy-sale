/**
 * hitc_easy_sale_client.ts
 * by Head in the Cloud Development, Inc.
 * gurus@headintheclouddev.com
 */

function easySalesPageInit() {
  console.log('easySalesPageInit', `Client script running version 20210319a.`);

  jQuery("#expireDate").datepicker({ dateFormat: "mm/yy" });

  // If you select something for ordering, auto-set quantity to 1
  jQuery('.selected').on('click', function () {
    const tableRow = jQuery(this).parents('tr:first');
    const quantity = tableRow.find('.quantity');
    const quantityAssigned = quantity.val();
    if (quantityAssigned === "") quantity.val(1);
    updateTotal();
  });

  jQuery('.quantity').on('change', updateTotal);

  // Validate card expiration date
  jQuery('form').on('submit', function() {
    const expireDate = jQuery('#expireDate');
    const expireDateValue = expireDate.val() as string;
    console.log(`Expire date value: ${expireDateValue}`);
    const expireLength = expireDateValue.length;
    console.log(`Expire date length: ${expireLength}`);
    const indexOfExpire = expireDateValue.toString().indexOf("/", 2); // split by / check 2 elements
    console.log(`Index: ${indexOfExpire}`);
    if (expireLength != 7 || indexOfExpire != 2) {
      alert('Please use the MM/YYYY format for the credit card expiration date');
      return false;
    } else {
      console.log(`Details are correct`);
    }
    if (jQuery('.selected:checked').length == 0) {
      alert('Please select at least one item to purchase');
      return false;
    }
  });

  // [HITC-156] Auto-fill values from URL
  const url = new URL(window.location.href);
  jQuery('#comments').val(url.searchParams.get('comment'));
  jQuery('#customer-email').val(url.searchParams.get('email'));

  jQuery('#customer-name').on('change', testModeAutoFill);
}

function updateTotal() {
  let total = 0;
  jQuery('#items-table tbody tr').each((idx, trElement) => {
    const lineAmount = Number(jQuery(trElement).find('.selected').data('price'));
    const quantity   = Number(jQuery(trElement).find('.quantity').val());
    if (jQuery(trElement).find('.selected').prop('checked')) total += lineAmount * quantity;
  });
  jQuery('#total').text(total);
}

function testModeAutoFill() {
  const nameField = jQuery('#customer-name');
  if (nameField.val() == 'test') {
    const testName = `Test ${new Date()}`;
    nameField.val(testName.substring(0, 29));
    jQuery('#customer-email').val(`test_${Date.now()}@test.com`);
    jQuery('#addr-line-1').val('2 Infinite Loop');
    jQuery('#city').val('Cupertino');
    jQuery('#state-select').val('CA');
    jQuery('#zip-code').val('95014');
    jQuery('#country-select').val('United States');
    jQuery('#comments').val('12345');
    jQuery('#card-type').val('4');
    jQuery('#cardholder-name').val('Robbie');
    jQuery('#card-number').val('5413330089099999');
    jQuery('#expireDate').val('02/2028');
    jQuery('#cvc').val('737');
    jQuery('#card-address').val('2 Infinite Loop');
  }
}
