import { createClient } from 'https://esm.sh/@supabase/supabase-js';
import { serve } from 'https://deno.land/std/http/server.ts';
import { encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

async function sendClaudeRequest(imageUrls: string[]) {
  const apiKey = "***REMOVED***";

  const contentArray = [];

  for (const imageUrl of imageUrls) {
    const imageResponse = await fetch(imageUrl);
    const imageData = await imageResponse.arrayBuffer();
    const base64Image = encode(new Uint8Array(imageData));
    const imageMediaType = imageResponse.headers.get("content-type") || "image/jpeg";

    contentArray.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMediaType,
        data: base64Image,
      },
    });
  }

  contentArray.push({
    type: "text",
    text: 'Analyze the given receipt images and extract relevant information in JSON format: { "merchant": { "name": "", "location": "" }, "receipt": { "transaction_number": "", "receipt_timestamp": "", "cashier_name": "", "till_number": "", "subtotal": 0, "tax_amount": 0, "total_amount": 0, "barcode": "" }, "items": [ { "description": "", "quantity": 0, "unit": "", "regular_price": 0, "discount_amount": 0, "discount_percentage": 0, "price": 0, "category": "", "subcategory": "", "brand": "", "product_code": "", "unit_of_measurement": "", "tax_amount": 0, "tax_rate": 0 } ], "payment_methods": [ { "method": "", "amount": 0 } ], "receipt_type": "" }',
  });

  const url = "https://api.anthropic.com/v1/messages";
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  const messages = [
    {
      role: "user",
      content: contentArray,
    },
  ];

  const payload = {
    model: "claude-3-opus-20240229",
    max_tokens: 4096,
    messages: messages,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    const result = await response.json();
    return result;
  } else {
    console.error(`Request failed with status code: ${response.status}`);
    console.error(`Error message: ${await response.text()}`);
    return null;
  }
}

async function processImage(imageUrls: string[], extractedData: any, supabase: any) {
  // Check if extractedData is not null or undefined
  if (!extractedData) {
    console.error('No data received from the API');
    return;
  }

  // Destructure the parsed data
  const { merchant, receipt, items, payment_methods, receipt_type } = extractedData;

  // Merchant information
  const { data: merchantData, error: merchantError } = await supabase
    .from('merchants')
    .select('id')
    .eq('name', merchant.name)
    .eq('location', merchant.location)
    .single();

  let merchantId;
  if (merchantError) {
    const { data: insertedMerchant, error: insertMerchantError } = await supabase
      .from('merchants')
      .insert({ name: merchant.name, location: merchant.location })
      .select('id')
      .single();

    if (insertMerchantError) {
      throw insertMerchantError;
    }

    merchantId = insertedMerchant.id;
  } else {
    merchantId = merchantData.id;
  }

  // Receipt type information
  const { data: receiptTypeData, error: receiptTypeError } = await supabase
    .from('receipt_types')
    .select('id')
    .eq('name', receipt_type)
    .single();

  let receiptTypeId;
  if (receiptTypeError) {
    const { data: insertedReceiptType, error: insertReceiptTypeError } = await supabase
      .from('receipt_types')
      .insert({ name: receipt_type })
      .select('id')
      .single();

    if (insertReceiptTypeError) {
      throw insertReceiptTypeError;
    }

    receiptTypeId = insertedReceiptType.id;
  } else {
    receiptTypeId = receiptTypeData.id;
  }

  // Check if receipt already exists
  const { data: existingReceipt, error: existingReceiptError } = await supabase
    .from('receipts')
    .select('id')
    .eq('transaction_number', receipt.transaction_number)
    .eq('merchant_id', merchantId)
    .single();

  let receiptId;
  if (existingReceiptError) {
    const { data: insertedReceipt, error: insertReceiptError } = await supabase
      .from('receipts')
      .insert({
        merchant_id: merchantId,
        receipt_type_id: receiptTypeId,
        transaction_number: receipt.transaction_number,
        receipt_timestamp: receipt.receipt_timestamp || null, // Set to null if empty or invalid
        cashier_name: receipt.cashier_name,
        till_number: receipt.till_number,
        subtotal: receipt.subtotal,
        tax_amount: receipt.tax_amount,
        total_amount: receipt.total_amount,
        barcode: receipt.barcode,
      })
      .select('id')
      .single();

    if (insertReceiptError) {
      throw insertReceiptError;
    }

    receiptId = insertedReceipt.id;
  } else {
    receiptId = existingReceipt.id;

    // Update receipt information
    const { error: updateReceiptError } = await supabase
      .from('receipts')
      .update({
        receipt_type_id: receiptTypeId,
        receipt_timestamp: receipt.receipt_timestamp || null, // Set to null if empty or invalid
        cashier_name: receipt.cashier_name,
        till_number: receipt.till_number,
        subtotal: receipt.subtotal,
        tax_amount: receipt.tax_amount,
        total_amount: receipt.total_amount,
        barcode: receipt.barcode,
      })
      .eq('id', receiptId);

    if (updateReceiptError) {
      throw updateReceiptError;
    }
  }

  // Delete existing receipt images
  const { error: deleteImagesError } = await supabase
    .from('receipt_images')
    .delete()
    .eq('receipt_id', receiptId);

  if (deleteImagesError) {
    throw deleteImagesError;
  }

  // Insert new receipt images
  for (const imageUrl of imageUrls) {
    const { error: receiptImageError } = await supabase
      .from('receipt_images')
      .insert({
        receipt_id: receiptId,
        image_url: imageUrl,
      });

    if (receiptImageError) {
      throw receiptImageError;
    }
  }

  // Delete existing raw response
  const { error: deleteRawResponseError } = await supabase
    .from('raw_responses')
    .delete()
    .eq('receipt_id', receiptId);

  if (deleteRawResponseError) {
    throw deleteRawResponseError;
  }

  // Insert new raw response
  const { data: insertedRawResponse, error: rawResponseError } = await supabase
    .from('raw_responses')
    .insert({
      receipt_id: receiptId,
      response_data: extractedData,
    })
    .single();

  if (rawResponseError) {
    throw rawResponseError;
  }

  // Delete existing extracted items
  const { error: deleteItemsError } = await supabase
    .from('extracted_items')
    .delete()
    .eq('receipt_id', receiptId);

  if (deleteItemsError) {
    throw deleteItemsError;
  }

  // Insert new extracted items
  if (items && Array.isArray(items)) {
    for (const item of items) {
      const { data: insertedItem, error: itemError } = await supabase
        .from('extracted_items')
        .insert({
          receipt_id: receiptId,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          regular_price: item.regular_price,
          discount_amount: item.discount_amount,
          discount_percentage: item.discount_percentage,
          price: item.price,
          category: item.category,
          subcategory: item.subcategory,
          brand: item.brand,
          product_code: item.product_code,
          unit_of_measurement: item.unit_of_measurement,
          tax_amount: item.tax_amount,
          tax_rate: item.tax_rate,
        })
        .single();

      if (itemError) {
        throw itemError;
      }
    }
  }

  // Delete existing payment methods
  const { error: deletePaymentMethodsError } = await supabase
    .from('receipt_payments')
    .delete()
    .eq('receipt_id', receiptId);

  if (deletePaymentMethodsError) {
    throw deletePaymentMethodsError;
  }

  // Insert new payment methods
  if (payment_methods && Array.isArray(payment_methods)) {
    for (const paymentMethod of payment_methods) {
      const { data: paymentMethodData, error: paymentMethodError } = await supabase
        .from('payment_methods')
        .select('id')
        .eq('name', paymentMethod.method)
        .single();

      let paymentMethodId;
      if (paymentMethodError) {
        const { data: insertedPaymentMethod, error: insertPaymentMethodError } = await supabase
          .from('payment_methods')
          .insert({ name: paymentMethod.method })
          .select('id')
          .single();

        if (insertPaymentMethodError) {
          throw insertPaymentMethodError;
        }

        paymentMethodId = insertedPaymentMethod.id;
      } else {
        paymentMethodId = paymentMethodData.id;
      }

      const { data: insertedReceiptPayment, error: receiptPaymentError } = await supabase
        .from('receipt_payments')
        .insert({
          receipt_id: receiptId,
          payment_method_id: paymentMethodId,
          amount: paymentMethod.amount,
        })
        .single();

      if (receiptPaymentError) {
        throw receiptPaymentError;
      }
    }
  }
}

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    if (req.method === 'POST') {
      const { imageUrls } = await req.json();

      if (!imageUrls || imageUrls.length === 0) {
        return new Response('No image URLs provided', { status: 400 });
      }

      const extractedData = await sendClaudeRequest(imageUrls);
      const ied = extractedData['content'][0].text;
      const ej = JSON.parse(ied);
      console.log(ej);

      try {
        await processImage(imageUrls, ej, supabase);

        return new Response(JSON.stringify(ej), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      } catch (err) {
        return new Response(String(err?.message ?? err), { status: 500 });
      }
    } else {
      return new Response('Method not allowed', { status: 405 });
    }
  } catch (err) {
    console.error('Error:', err);
    return new Response(String(err?.message ?? err), { status: 500 });
  }
});