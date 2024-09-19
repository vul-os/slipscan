import { createClient } from 'https://esm.sh/@supabase/supabase-js';
import { serve } from 'https://deno.land/std/http/server.ts';
import { encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

async function sendClaudeRequest(imageUrls: string[]) {
  const apiKey = "***REMOVED***"
  
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
    text: 'Analyze the given receipt images and extract relevant information. Respond ONLY with a JSON object in this exact format, with no additional text: { "merchant": { "name": "", "location": "" }, "receipt": { "transaction_number": "", "receipt_timestamp": "", "cashier_name": "", "till_number": "", "subtotal": 0, "tax_amount": 0, "total_amount": 0, "barcode": "" }, "items": [ { "description": "", "quantity": 0, "unit": "", "regular_price": 0, "discount_amount": 0, "discount_percentage": 0, "price": 0, "category": "", "subcategory": "", "brand": "", "product_code": "", "unit_of_measurement": "", "tax_amount": 0, "tax_rate": 0 } ], "payment_methods": [ { "method": "", "amount": 0 } ], "receipt_type": "" }',
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
    model: "claude-3-5-sonnet-20240620",
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
  if (!extractedData) {
    console.error('No data received from the API');
    return;
  }

  const { merchant, receipt, items, payment_methods, receipt_type } = extractedData;

  // Merchant
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

    if (insertMerchantError) throw insertMerchantError;
    merchantId = insertedMerchant.id;
  } else {
    merchantId = merchantData.id;
  }

  // Document type
  const { data: documentTypeData, error: documentTypeError } = await supabase
    .from('document_types')
    .select('id')
    .eq('name', receipt_type)
    .single();

  let documentTypeId;
  if (documentTypeError) {
    const { data: insertedDocumentType, error: insertDocumentTypeError } = await supabase
      .from('document_types')
      .insert({ name: receipt_type })
      .select('id')
      .single();

    if (insertDocumentTypeError) throw insertDocumentTypeError;
    documentTypeId = insertedDocumentType.id;
  } else {
    documentTypeId = documentTypeData.id;
  }

  // Document
  const { data: existingDocument, error: existingDocumentError } = await supabase
    .from('documents')
    .select('id')
    .eq('transaction_number', receipt.transaction_number)
    .eq('merchant_id', merchantId)
    .single();

  let documentId;
  if (existingDocumentError) {
    const { data: insertedDocument, error: insertDocumentError } = await supabase
      .from('documents')
      .insert({
        merchant_id: merchantId,
        document_type_id: documentTypeId,
        transaction_number: receipt.transaction_number,
        document_timestamp: receipt.receipt_timestamp || null,
        cashier_name: receipt.cashier_name,
        till_number: receipt.till_number,
        subtotal: receipt.subtotal,
        tax_amount: receipt.tax_amount,
        total_amount: receipt.total_amount,
        barcode: receipt.barcode,
        ocr_processed: true,
      })
      .select('id')
      .single();

    if (insertDocumentError) throw insertDocumentError;
    documentId = insertedDocument.id;
  } else {
    documentId = existingDocument.id;

    const { error: updateDocumentError } = await supabase
      .from('documents')
      .update({
        document_type_id: documentTypeId,
        document_timestamp: receipt.receipt_timestamp || null,
        cashier_name: receipt.cashier_name,
        till_number: receipt.till_number,
        subtotal: receipt.subtotal,
        tax_amount: receipt.tax_amount,
        total_amount: receipt.total_amount,
        barcode: receipt.barcode,
        ocr_processed: true,
      })
      .eq('id', documentId);

    if (updateDocumentError) throw updateDocumentError;
  }

  // Document images
  const { error: deleteImagesError } = await supabase
    .from('document_images')
    .delete()
    .eq('document_id', documentId);

  if (deleteImagesError) throw deleteImagesError;

  for (const imageUrl of imageUrls) {
    const { error: documentImageError } = await supabase
      .from('document_images')
      .insert({
        document_id: documentId,
        bucket_name: 'receipts', // Adjust as needed
        file_path: imageUrl,
        file_name: imageUrl.split('/').pop(),
      });

    if (documentImageError) throw documentImageError;
  }

  // OCR results
  const { error: deleteOcrResultsError } = await supabase
    .from('ocr_results')
    .delete()
    .eq('document_id', documentId);

  if (deleteOcrResultsError) throw deleteOcrResultsError;

  const { error: ocrResultError } = await supabase
    .from('ocr_results')
    .insert({
      document_id: documentId,
      raw_text: JSON.stringify(extractedData),
      confidence_score: 1, // Adjust as needed
    });

  if (ocrResultError) throw ocrResultError;

  // Extracted items
  const { error: deleteItemsError } = await supabase
    .from('extracted_items')
    .delete()
    .eq('document_id', documentId);

  if (deleteItemsError) throw deleteItemsError;

  if (items && Array.isArray(items)) {
    for (const item of items) {
      // Get or create category
      let categoryId = null;
      if (item.category) {
        const { data: categoryData, error: categoryError } = await supabase
          .from('categories')
          .select('id')
          .eq('name', item.category)
          .single();

        if (categoryError) {
          const { data: insertedCategory, error: insertCategoryError } = await supabase
            .from('categories')
            .insert({ name: item.category })
            .select('id')
            .single();

          if (insertCategoryError) throw insertCategoryError;
          categoryId = insertedCategory.id;
        } else {
          categoryId = categoryData.id;
        }
      }

      // Get or create subcategory
      let subcategoryId = null;
      if (item.subcategory && categoryId) {
        const { data: subcategoryData, error: subcategoryError } = await supabase
          .from('subcategories')
          .select('id')
          .eq('category_id', categoryId)
          .eq('name', item.subcategory)
          .single();

        if (subcategoryError) {
          const { data: insertedSubcategory, error: insertSubcategoryError } = await supabase
            .from('subcategories')
            .insert({ category_id: categoryId, name: item.subcategory })
            .select('id')
            .single();

          if (insertSubcategoryError) throw insertSubcategoryError;
          subcategoryId = insertedSubcategory.id;
        } else {
          subcategoryId = subcategoryData.id;
        }
      }

      const { error: itemError } = await supabase
        .from('extracted_items')
        .insert({
          document_id: documentId,
          category_id: categoryId,
          subcategory_id: subcategoryId,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          regular_price: item.regular_price,
          discount_amount: item.discount_amount,
          discount_percentage: item.discount_percentage,
          price: item.price,
          brand: item.brand,
          product_code: item.product_code,
          tax_amount: item.tax_amount,
          tax_rate: item.tax_rate,
        });

      if (itemError) throw itemError;
    }
  }

  // Payment methods
  const { error: deletePaymentMethodsError } = await supabase
    .from('document_payments')
    .delete()
    .eq('document_id', documentId);

  if (deletePaymentMethodsError) throw deletePaymentMethodsError;

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

        if (insertPaymentMethodError) throw insertPaymentMethodError;
        paymentMethodId = insertedPaymentMethod.id;
      } else {
        paymentMethodId = paymentMethodData.id;
      }

      const { error: documentPaymentError } = await supabase
        .from('document_payments')
        .insert({
          document_id: documentId,
          payment_method_id: paymentMethodId,
          amount: paymentMethod.amount,
        });

      if (documentPaymentError) throw documentPaymentError;
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