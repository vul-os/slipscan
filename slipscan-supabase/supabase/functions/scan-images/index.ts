import { createClient } from 'https://esm.sh/@supabase/supabase-js';
import { serve } from 'https://deno.land/std/http/server.ts';
import { encode } from "https://deno.land/std@0.177.0/encoding/base64.ts";

// Define CORS headers to allow all origins
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
  console.log('1. Starting processImage function');
  // console.log('userId:', userId);
  const userId = "00000000-0000-0000-0000-000000000000"
  if (!extractedData) {
    console.error('2. No data received from the API');
    return;
  }

  const { merchant, receipt, items, payment_methods, receipt_type } = extractedData;
  console.log('3. Extracted data:', { merchant, receipt, items, payment_methods, receipt_type });

  // Merchant
  console.log('4. Processing merchant');
  const { data: merchantData, error: merchantError } = await supabase
    .from('merchants')
    .select('id')
    .eq('user_id', userId)
    .eq('name', merchant.name)
    .eq('location', merchant.location)
    .single();

  console.log('5. Merchant query result:', { merchantData, merchantError });

  let merchantId;
  if (merchantError) {
    console.log('6. Inserting new merchant');
    const { data: insertedMerchant, error: insertMerchantError } = await supabase
      .from('merchants')
      .insert({ user_id: userId, name: merchant.name, location: merchant.location })
      .select('id')
      .single();

    console.log('7. Insert merchant result:', { insertedMerchant, insertMerchantError });
    if (insertMerchantError) throw insertMerchantError;
    merchantId = insertedMerchant.id;
  } else {
    merchantId = merchantData.id;
  }
  console.log('8. Merchant ID:', merchantId);

  // Document type
  console.log('9. Processing document type');
  const { data: documentTypeData, error: documentTypeError } = await supabase
    .from('document_types')
    .select('id')
    .eq('user_id', userId)
    .eq('name', receipt_type)
    .single();

  console.log('10. Document type query result:', { documentTypeData, documentTypeError });

  let documentTypeId;
  if (documentTypeError) {
    console.log('11. Inserting new document type');
    const { data: insertedDocumentType, error: insertDocumentTypeError } = await supabase
      .from('document_types')
      .insert({ user_id: userId, name: receipt_type })
      .select('id')
      .single();

    console.log('12. Insert document type result:', { insertedDocumentType, insertDocumentTypeError });
    if (insertDocumentTypeError) throw insertDocumentTypeError;
    documentTypeId = insertedDocumentType.id;
  } else {
    documentTypeId = documentTypeData.id;
  }
  console.log('13. Document Type ID:', documentTypeId);

  // Document group
  console.log('14. Creating document group');
  const { data: documentGroup, error: documentGroupError } = await supabase
    .from('document_groups')
    .insert({ user_id: userId, name: `Receipt ${receipt.transaction_number}` })
    .select('id')
    .single();

  console.log('15. Document group creation result:', { documentGroup, documentGroupError });
  if (documentGroupError) throw documentGroupError;
  const documentGroupId = documentGroup.id;

  // Document
  console.log('16. Processing document');
  const { data: existingDocument, error: existingDocumentError } = await supabase
    .from('documents')
    .select('id')
    .eq('user_id', userId)
    .eq('transaction_number', receipt.transaction_number)
    .eq('merchant_id', merchantId)
    .single();

  console.log('17. Existing document query result:', { existingDocument, existingDocumentError });

  let documentId;
  if (existingDocumentError) {
    console.log('18. Inserting new document');
    const { data: insertedDocument, error: insertDocumentError } = await supabase
      .from('documents')
      .insert({
        user_id: userId,
        document_group_id: documentGroupId,
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

    console.log('19. Insert document result:', { insertedDocument, insertDocumentError });
    if (insertDocumentError) throw insertDocumentError;
    documentId = insertedDocument.id;
  } else {
    documentId = existingDocument.id;
    console.log('20. Updating existing document');
    const { error: updateDocumentError } = await supabase
      .from('documents')
      .update({
        document_group_id: documentGroupId,
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

    console.log('21. Update document result:', { updateDocumentError });
    if (updateDocumentError) throw updateDocumentError;
  }
  console.log('22. Document ID:', documentId);

  // Document files
  console.log('23. Processing document files');
  const { error: deleteFilesError } = await supabase
    .from('document_files')
    .delete()
    .eq('user_id', userId)
    .eq('document_id', documentId);

  console.log('24. Delete existing files result:', { deleteFilesError });
  if (deleteFilesError) throw deleteFilesError;

  for (const imageUrl of imageUrls) {
    console.log('25. Inserting document file:', imageUrl);
    const { error: documentFileError } = await supabase
      .from('document_files')
      .insert({
        user_id: userId,
        document_id: documentId,
        bucket_name: 'receipts',
        file_path: imageUrl,
        file_name: imageUrl.split('/').pop(),
      });

    console.log('26. Insert document file result:', { documentFileError });
    if (documentFileError) throw documentFileError;
  }

  // OCR results
  console.log('27. Processing OCR results');
  const { error: deleteOcrResultsError } = await supabase
    .from('ocr_results')
    .delete()
    .eq('user_id', userId)
    .eq('document_id', documentId);

  console.log('28. Delete existing OCR results:', { deleteOcrResultsError });
  if (deleteOcrResultsError) throw deleteOcrResultsError;

  const { error: ocrResultError } = await supabase
    .from('ocr_results')
    .insert({
      user_id: userId,
      document_id: documentId,
      raw_text: JSON.stringify(extractedData),
      confidence_score: 1,
    });

  console.log('29. Insert OCR result:', { ocrResultError });
  if (ocrResultError) throw ocrResultError;

  // Extracted items
  console.log('30. Processing extracted items');
  const { error: deleteItemsError } = await supabase
    .from('extracted_items')
    .delete()
    .eq('user_id', userId)
    .eq('document_group_id', documentGroupId);

  console.log('31. Delete existing items result:', { deleteItemsError });
  if (deleteItemsError) throw deleteItemsError;

  if (items && Array.isArray(items)) {
    for (const item of items) {
      console.log('32. Processing item:', item);
      // Get or create category
      let categoryId = null;
      if (item.category) {
        const { data: categoryData, error: categoryError } = await supabase
          .from('categories')
          .select('id')
          .eq('user_id', userId)
          .eq('name', item.category)
          .single();

        console.log('33. Category query result:', { categoryData, categoryError });

        if (categoryError) {
          const { data: insertedCategory, error: insertCategoryError } = await supabase
            .from('categories')
            .insert({ user_id: userId, name: item.category })
            .select('id')
            .single();

          console.log('34. Insert category result:', { insertedCategory, insertCategoryError });
          if (insertCategoryError) throw insertCategoryError;
          categoryId = insertedCategory.id;
        } else {
          categoryId = categoryData.id;
        }
      }
      console.log('35. Category ID:', categoryId);

      // Get or create subcategory
      let subcategoryId = null;
      if (item.subcategory && categoryId) {
        const { data: subcategoryData, error: subcategoryError } = await supabase
          .from('subcategories')
          .select('id')
          .eq('user_id', userId)
          .eq('category_id', categoryId)
          .eq('name', item.subcategory)
          .single();

        console.log('36. Subcategory query result:', { subcategoryData, subcategoryError });

        if (subcategoryError) {
          const { data: insertedSubcategory, error: insertSubcategoryError } = await supabase
            .from('subcategories')
            .insert({ user_id: userId, category_id: categoryId, name: item.subcategory })
            .select('id')
            .single();

          console.log('37. Insert subcategory result:', { insertedSubcategory, insertSubcategoryError });
          if (insertSubcategoryError) throw insertSubcategoryError;
          subcategoryId = insertedSubcategory.id;
        } else {
          subcategoryId = subcategoryData.id;
        }
      }
      console.log('38. Subcategory ID:', subcategoryId);

      console.log('39. Inserting extracted item');
      const { error: itemError } = await supabase
        .from('extracted_items')
        .insert({
          user_id: userId,
          document_group_id: documentGroupId,
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

      console.log('40. Insert item result:', { itemError });
      if (itemError) throw itemError;
    }
  }

  // Payment methods
  console.log('41. Processing payment methods');
  const { error: deletePaymentMethodsError } = await supabase
    .from('document_payments')
    .delete()
    .eq('user_id', userId)
    .eq('document_id', documentId);

  console.log('42. Delete existing payment methods result:', { deletePaymentMethodsError });
  if (deletePaymentMethodsError) throw deletePaymentMethodsError;

  if (payment_methods && Array.isArray(payment_methods)) {
    for (const paymentMethod of payment_methods) {
      console.log('43. Processing payment method:', paymentMethod);
      const { data: paymentMethodData, error: paymentMethodError } = await supabase
        .from('payment_methods')
        .select('id')
        .eq('user_id', userId)
        .eq('name', paymentMethod.method)
        .single();

      console.log('44. Payment method query result:', { paymentMethodData, paymentMethodError });

      let paymentMethodId;
      if (paymentMethodError) {
        const { data: insertedPaymentMethod, error: insertPaymentMethodError } = await supabase
          .from('payment_methods')
          .insert({ user_id: userId, name: paymentMethod.method })
          .select('id')
          .single();

        console.log('45. Insert payment method result:', { insertedPaymentMethod, insertPaymentMethodError });
        if (insertPaymentMethodError) throw insertPaymentMethodError;
        paymentMethodId = insertedPaymentMethod.id;
      } else {
        paymentMethodId = paymentMethodData.id;
      }
      console.log('46. Payment Method ID:', paymentMethodId);

      console.log('47. Inserting document payment');
      const { error: documentPaymentError } = await supabase
        .from('document_payments')
        .insert({
          user_id: userId,
          document_id: documentId,
          payment_method_id: paymentMethodId,
          amount: paymentMethod.amount,
        });

      console.log('48. Insert document payment result:', { documentPaymentError });
      if (documentPaymentError) throw documentPaymentError;
    }
  }

  console.log('49. processImage function completed');
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    if (req.method === 'POST') {
      const { imageUrls } = await req.json();

      if (!imageUrls || imageUrls.length === 0) {
        return new Response('No image URLs provided', { 
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const extractedData = await sendClaudeRequest(imageUrls);
      const ied = extractedData['content'][0].text;
      const ej = JSON.parse(ied);
      console.log(ej);

      try {
        await processImage(imageUrls, ej, supabase);

        return new Response(JSON.stringify(ej), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(String(err?.message ?? err), { 
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    } else {
      return new Response('Method not allowed', { 
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    console.error('Error:', err);
    return new Response(String(err?.message ?? err), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});