
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "public"."current_user_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN (SELECT id FROM auth.users WHERE username = current_user);
END;
$$;

ALTER FUNCTION "public"."current_user_id"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."delete_document_and_files"("doc_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Delete associated files first
  DELETE FROM document_files WHERE document_id = doc_id;
  
  -- Then delete the document
  DELETE FROM documents WHERE id = doc_id;
END;
$$;

ALTER FUNCTION "public"."delete_document_and_files"("doc_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."delete_document_group_and_associated_data"("group_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Delete document group-specific associated records
    DELETE FROM document_tag_links WHERE document_group_id = group_id;
    DELETE FROM customer_loyalty WHERE document_group_id = group_id;
    DELETE FROM document_payments WHERE document_group_id = group_id;
    DELETE FROM ocr_results WHERE document_group_id = group_id;
    DELETE FROM document_files WHERE document_group_id = group_id;

    -- Delete group-level associated records
    DELETE FROM user_modified_extracted_items WHERE document_group_id = group_id;
    DELETE FROM extracted_items WHERE document_group_id = group_id;

    -- Finally, delete the document group itself
    DELETE FROM document_groups WHERE id = group_id;
END;
$$;

ALTER FUNCTION "public"."delete_document_group_and_associated_data"("group_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."delete_document_group_and_files"("group_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Delete associated files first
  DELETE FROM document_files WHERE document_group_id = group_id;
  
  -- Then delete the document group
  DELETE FROM document_groups WHERE id = group_id;
END;
$$;

ALTER FUNCTION "public"."delete_document_group_and_files"("group_id" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, email, avatar_url)
    VALUES (
        new.id, 
        new.raw_user_meta_data->>'full_name', 
        new.email,  -- Retrieve email directly from the new auth.user
        new.raw_user_meta_data->>'avatar_url'
    );
    RETURN new;
END;
$$;

ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255) NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."categories" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."customer_loyalty" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "document_group_id" "uuid" NOT NULL,
    "loyalty_program_id" "uuid" NOT NULL,
    "card_number" character varying(255),
    "points_earned" numeric(10,2),
    "points_redeemed" numeric(10,2),
    "balance" numeric(10,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."customer_loyalty" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_files" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "document_group_id" "uuid" NOT NULL,
    "bucket_name" character varying(255) NOT NULL,
    "file_path" character varying(255) NOT NULL,
    "file_name" character varying(255) NOT NULL,
    "content_type" character varying(100),
    "file_size" integer,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_files" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_groups" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255),
    "description" "text",
    "merchant_id" "uuid",
    "document_type_id" "uuid",
    "status_id" "uuid",
    "transaction_number" character varying(255),
    "document_timestamp" timestamp with time zone,
    "cashier_name" character varying(255),
    "till_number" character varying(50),
    "subtotal" numeric(10,2),
    "tax_amount" numeric(10,2),
    "total_amount" numeric(10,2),
    "barcode" character varying(255),
    "ocr_processed" boolean DEFAULT false NOT NULL,
    "manual_review_needed" boolean DEFAULT false NOT NULL,
    "review_notes" "text",
    "image_quality_score" numeric(3,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_groups" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_payments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "document_group_id" "uuid" NOT NULL,
    "payment_method_id" "uuid",
    "amount" numeric(10,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_payments" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_status" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_status" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_tag_links" (
    "document_group_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_tag_links" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_tags" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_tags" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."document_types" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."document_types" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."extracted_items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "document_group_id" "uuid" NOT NULL,
    "category_id" "uuid",
    "subcategory_id" "uuid",
    "description" "text",
    "quantity" numeric(10,3),
    "unit" character varying(50),
    "regular_price" numeric(10,2),
    "discount_amount" numeric(10,2),
    "discount_percentage" numeric(5,2),
    "price" numeric(10,2),
    "brand" character varying(255),
    "product_code" character varying(255),
    "tax_amount" numeric(10,2),
    "tax_rate" numeric(5,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."extracted_items" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."loyalty_programs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "merchant_id" "uuid" NOT NULL,
    "name" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."loyalty_programs" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."merchants" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255) NOT NULL,
    "location" character varying(255),
    "contact_number" character varying(50),
    "vat_number" character varying(50),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."merchants" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."ocr_results" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "document_group_id" "uuid" NOT NULL,
    "raw_text" "text" NOT NULL,
    "confidence_score" numeric(5,4),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."ocr_results" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payment_methods" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "name" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."payment_methods" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "updated_at" timestamp with time zone,
    "username" "text",
    "full_name" "text",
    "email" "text",
    "avatar_url" "text",
    "website" "text",
    CONSTRAINT "username_length" CHECK (("char_length"("username") >= 3))
);

ALTER TABLE "public"."profiles" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."subcategories" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "category_id" "uuid" NOT NULL,
    "name" character varying(255) NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."subcategories" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."user_modified_extracted_items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "document_group_id" "uuid" NOT NULL,
    "original_extracted_item_id" "uuid" NOT NULL,
    "category_id" "uuid",
    "subcategory_id" "uuid",
    "description" "text",
    "quantity" numeric(10,3),
    "unit" character varying(50),
    "regular_price" numeric(10,2),
    "discount_amount" numeric(10,2),
    "discount_percentage" numeric(5,2),
    "price" numeric(10,2),
    "brand" character varying(255),
    "product_code" character varying(255),
    "tax_amount" numeric(10,2),
    "tax_rate" numeric(5,2),
    "modification_timestamp" timestamp with time zone DEFAULT "now"() NOT NULL,
    "modification_reason" "text"
);

ALTER TABLE "public"."user_modified_extracted_items" OWNER TO "postgres";

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."customer_loyalty"
    ADD CONSTRAINT "customer_loyalty_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."customer_loyalty"
    ADD CONSTRAINT "customer_loyalty_unique_user_document_group_program" UNIQUE ("user_id", "document_group_id", "loyalty_program_id");

ALTER TABLE ONLY "public"."document_files"
    ADD CONSTRAINT "document_files_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."document_files"
    ADD CONSTRAINT "document_files_unique_user_document_file" UNIQUE ("user_id", "document_group_id", "file_path");

ALTER TABLE ONLY "public"."document_groups"
    ADD CONSTRAINT "document_groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."document_groups"
    ADD CONSTRAINT "document_groups_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."document_groups"
    ADD CONSTRAINT "document_groups_unique_user_transaction" UNIQUE ("user_id", "transaction_number");

ALTER TABLE ONLY "public"."document_payments"
    ADD CONSTRAINT "document_payments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."document_payments"
    ADD CONSTRAINT "document_payments_unique_user_document_group_method" UNIQUE ("user_id", "document_group_id", "payment_method_id");

ALTER TABLE ONLY "public"."document_status"
    ADD CONSTRAINT "document_status_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."document_status"
    ADD CONSTRAINT "document_status_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."document_tag_links"
    ADD CONSTRAINT "document_tag_links_pkey" PRIMARY KEY ("document_group_id", "tag_id");

ALTER TABLE ONLY "public"."document_tags"
    ADD CONSTRAINT "document_tags_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."document_tags"
    ADD CONSTRAINT "document_tags_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."document_types"
    ADD CONSTRAINT "document_types_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."document_types"
    ADD CONSTRAINT "document_types_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."extracted_items"
    ADD CONSTRAINT "extracted_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."extracted_items"
    ADD CONSTRAINT "extracted_items_unique_user_group_description" UNIQUE ("user_id", "document_group_id", "description");

ALTER TABLE ONLY "public"."loyalty_programs"
    ADD CONSTRAINT "loyalty_programs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."loyalty_programs"
    ADD CONSTRAINT "loyalty_programs_unique_user_merchant_name" UNIQUE ("user_id", "merchant_id", "name");

ALTER TABLE ONLY "public"."merchants"
    ADD CONSTRAINT "merchants_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."merchants"
    ADD CONSTRAINT "merchants_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."ocr_results"
    ADD CONSTRAINT "ocr_results_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."ocr_results"
    ADD CONSTRAINT "ocr_results_unique_user_document_group" UNIQUE ("user_id", "document_group_id");

ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payment_methods"
    ADD CONSTRAINT "payment_methods_unique_user_name" UNIQUE ("user_id", "name");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");

ALTER TABLE ONLY "public"."subcategories"
    ADD CONSTRAINT "subcategories_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."subcategories"
    ADD CONSTRAINT "subcategories_unique_user_category_name" UNIQUE ("user_id", "category_id", "name");

ALTER TABLE ONLY "public"."user_modified_extracted_items"
    ADD CONSTRAINT "user_modified_extracted_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."user_modified_extracted_items"
    ADD CONSTRAINT "user_modified_extracted_items_unique_user_group_original" UNIQUE ("user_id", "document_group_id", "original_extracted_item_id");

CREATE INDEX "idx_categories_user_id" ON "public"."categories" USING "btree" ("user_id");

CREATE INDEX "idx_customer_loyalty_user_id" ON "public"."customer_loyalty" USING "btree" ("user_id");

CREATE INDEX "idx_document_files_document_group_id" ON "public"."document_files" USING "btree" ("document_group_id");

CREATE INDEX "idx_document_files_user_id" ON "public"."document_files" USING "btree" ("user_id");

CREATE INDEX "idx_document_groups_document_type_id" ON "public"."document_groups" USING "btree" ("document_type_id");

CREATE INDEX "idx_document_groups_merchant_id" ON "public"."document_groups" USING "btree" ("merchant_id");

CREATE INDEX "idx_document_groups_status_id" ON "public"."document_groups" USING "btree" ("status_id");

CREATE INDEX "idx_document_groups_user_id" ON "public"."document_groups" USING "btree" ("user_id");

CREATE INDEX "idx_document_payments_user_id" ON "public"."document_payments" USING "btree" ("user_id");

CREATE INDEX "idx_document_status_user_id" ON "public"."document_status" USING "btree" ("user_id");

CREATE INDEX "idx_document_tag_links_user_id" ON "public"."document_tag_links" USING "btree" ("user_id");

CREATE INDEX "idx_document_tags_user_id" ON "public"."document_tags" USING "btree" ("user_id");

CREATE INDEX "idx_document_types_user_id" ON "public"."document_types" USING "btree" ("user_id");

CREATE INDEX "idx_extracted_items_category_id" ON "public"."extracted_items" USING "btree" ("category_id");

CREATE INDEX "idx_extracted_items_document_group_id" ON "public"."extracted_items" USING "btree" ("document_group_id");

CREATE INDEX "idx_extracted_items_subcategory_id" ON "public"."extracted_items" USING "btree" ("subcategory_id");

CREATE INDEX "idx_extracted_items_user_id" ON "public"."extracted_items" USING "btree" ("user_id");

CREATE INDEX "idx_loyalty_programs_user_id" ON "public"."loyalty_programs" USING "btree" ("user_id");

CREATE INDEX "idx_merchants_user_id" ON "public"."merchants" USING "btree" ("user_id");

CREATE INDEX "idx_ocr_results_user_id" ON "public"."ocr_results" USING "btree" ("user_id");

CREATE INDEX "idx_payment_methods_user_id" ON "public"."payment_methods" USING "btree" ("user_id");

CREATE INDEX "idx_subcategories_category_id" ON "public"."subcategories" USING "btree" ("category_id");

CREATE INDEX "idx_subcategories_user_id" ON "public"."subcategories" USING "btree" ("user_id");

CREATE INDEX "idx_user_modified_extracted_items_document_group_id" ON "public"."user_modified_extracted_items" USING "btree" ("document_group_id");

CREATE INDEX "idx_user_modified_extracted_items_modification_timestamp" ON "public"."user_modified_extracted_items" USING "btree" ("modification_timestamp");

CREATE INDEX "idx_user_modified_extracted_items_original_extracted_item_id" ON "public"."user_modified_extracted_items" USING "btree" ("original_extracted_item_id");

CREATE INDEX "idx_user_modified_extracted_items_user_id" ON "public"."user_modified_extracted_items" USING "btree" ("user_id");

ALTER TABLE ONLY "public"."customer_loyalty"
    ADD CONSTRAINT "fk_customer_loyalty_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."customer_loyalty"
    ADD CONSTRAINT "fk_customer_loyalty_loyalty_program" FOREIGN KEY ("loyalty_program_id") REFERENCES "public"."loyalty_programs"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."document_files"
    ADD CONSTRAINT "fk_document_files_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."document_groups"
    ADD CONSTRAINT "fk_document_groups_document_type" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."document_groups"
    ADD CONSTRAINT "fk_document_groups_merchant" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."document_groups"
    ADD CONSTRAINT "fk_document_groups_status" FOREIGN KEY ("status_id") REFERENCES "public"."document_status"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."document_payments"
    ADD CONSTRAINT "fk_document_payments_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."document_payments"
    ADD CONSTRAINT "fk_document_payments_payment_method" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."document_tag_links"
    ADD CONSTRAINT "fk_document_tag_links_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."document_tag_links"
    ADD CONSTRAINT "fk_document_tag_links_tag" FOREIGN KEY ("tag_id") REFERENCES "public"."document_tags"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."extracted_items"
    ADD CONSTRAINT "fk_extracted_items_category" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."extracted_items"
    ADD CONSTRAINT "fk_extracted_items_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."extracted_items"
    ADD CONSTRAINT "fk_extracted_items_subcategory" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."loyalty_programs"
    ADD CONSTRAINT "fk_loyalty_programs_merchant" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ocr_results"
    ADD CONSTRAINT "fk_ocr_results_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."subcategories"
    ADD CONSTRAINT "fk_subcategories_category" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_modified_extracted_items"
    ADD CONSTRAINT "fk_user_modified_extracted_items_category" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."user_modified_extracted_items"
    ADD CONSTRAINT "fk_user_modified_extracted_items_document_group" FOREIGN KEY ("document_group_id") REFERENCES "public"."document_groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_modified_extracted_items"
    ADD CONSTRAINT "fk_user_modified_extracted_items_original_item" FOREIGN KEY ("original_extracted_item_id") REFERENCES "public"."extracted_items"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_modified_extracted_items"
    ADD CONSTRAINT "fk_user_modified_extracted_items_subcategory" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categories_user_policy" ON "public"."categories" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."customer_loyalty" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_loyalty_user_policy" ON "public"."customer_loyalty" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_files" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_files_user_policy" ON "public"."document_files" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_groups" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_groups_user_policy" ON "public"."document_groups" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_payments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_payments_user_policy" ON "public"."document_payments" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_status" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_status_user_policy" ON "public"."document_status" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_tag_links" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_tag_links_user_policy" ON "public"."document_tag_links" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_tags" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_tags_user_policy" ON "public"."document_tags" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."document_types" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_types_user_policy" ON "public"."document_types" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."extracted_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "extracted_items_user_policy" ON "public"."extracted_items" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."loyalty_programs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "loyalty_programs_user_policy" ON "public"."loyalty_programs" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."merchants" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "merchants_user_policy" ON "public"."merchants" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."ocr_results" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ocr_results_user_policy" ON "public"."ocr_results" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."payment_methods" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_methods_user_policy" ON "public"."payment_methods" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_user_policy" ON "public"."profiles" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));

ALTER TABLE "public"."subcategories" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subcategories_user_policy" ON "public"."subcategories" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

ALTER TABLE "public"."user_modified_extracted_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_modified_extracted_items_user_policy" ON "public"."user_modified_extracted_items" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT ALL ON FUNCTION "public"."current_user_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "service_role";

GRANT ALL ON FUNCTION "public"."delete_document_and_files"("doc_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_document_and_files"("doc_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_document_and_files"("doc_id" "uuid") TO "service_role";

GRANT ALL ON FUNCTION "public"."delete_document_group_and_associated_data"("group_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_document_group_and_associated_data"("group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_document_group_and_associated_data"("group_id" "uuid") TO "service_role";

GRANT ALL ON FUNCTION "public"."delete_document_group_and_files"("group_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."delete_document_group_and_files"("group_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_document_group_and_files"("group_id" "uuid") TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";

GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";

GRANT ALL ON TABLE "public"."customer_loyalty" TO "anon";
GRANT ALL ON TABLE "public"."customer_loyalty" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_loyalty" TO "service_role";

GRANT ALL ON TABLE "public"."document_files" TO "anon";
GRANT ALL ON TABLE "public"."document_files" TO "authenticated";
GRANT ALL ON TABLE "public"."document_files" TO "service_role";

GRANT ALL ON TABLE "public"."document_groups" TO "anon";
GRANT ALL ON TABLE "public"."document_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."document_groups" TO "service_role";

GRANT ALL ON TABLE "public"."document_payments" TO "anon";
GRANT ALL ON TABLE "public"."document_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."document_payments" TO "service_role";

GRANT ALL ON TABLE "public"."document_status" TO "anon";
GRANT ALL ON TABLE "public"."document_status" TO "authenticated";
GRANT ALL ON TABLE "public"."document_status" TO "service_role";

GRANT ALL ON TABLE "public"."document_tag_links" TO "anon";
GRANT ALL ON TABLE "public"."document_tag_links" TO "authenticated";
GRANT ALL ON TABLE "public"."document_tag_links" TO "service_role";

GRANT ALL ON TABLE "public"."document_tags" TO "anon";
GRANT ALL ON TABLE "public"."document_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."document_tags" TO "service_role";

GRANT ALL ON TABLE "public"."document_types" TO "anon";
GRANT ALL ON TABLE "public"."document_types" TO "authenticated";
GRANT ALL ON TABLE "public"."document_types" TO "service_role";

GRANT ALL ON TABLE "public"."extracted_items" TO "anon";
GRANT ALL ON TABLE "public"."extracted_items" TO "authenticated";
GRANT ALL ON TABLE "public"."extracted_items" TO "service_role";

GRANT ALL ON TABLE "public"."loyalty_programs" TO "anon";
GRANT ALL ON TABLE "public"."loyalty_programs" TO "authenticated";
GRANT ALL ON TABLE "public"."loyalty_programs" TO "service_role";

GRANT ALL ON TABLE "public"."merchants" TO "anon";
GRANT ALL ON TABLE "public"."merchants" TO "authenticated";
GRANT ALL ON TABLE "public"."merchants" TO "service_role";

GRANT ALL ON TABLE "public"."ocr_results" TO "anon";
GRANT ALL ON TABLE "public"."ocr_results" TO "authenticated";
GRANT ALL ON TABLE "public"."ocr_results" TO "service_role";

GRANT ALL ON TABLE "public"."payment_methods" TO "anon";
GRANT ALL ON TABLE "public"."payment_methods" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_methods" TO "service_role";

GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";

GRANT ALL ON TABLE "public"."subcategories" TO "anon";
GRANT ALL ON TABLE "public"."subcategories" TO "authenticated";
GRANT ALL ON TABLE "public"."subcategories" TO "service_role";

GRANT ALL ON TABLE "public"."user_modified_extracted_items" TO "anon";
GRANT ALL ON TABLE "public"."user_modified_extracted_items" TO "authenticated";
GRANT ALL ON TABLE "public"."user_modified_extracted_items" TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";

RESET ALL;
