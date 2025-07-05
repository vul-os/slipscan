-- Create profiles table EXACTLY as in original
CREATE TABLE profiles (
    id uuid references auth.users on delete cascade not null primary key,
    updated_at timestamp with time zone,
    username text unique,
    full_name text,
    email text unique,
    avatar_url text,
    website text,
    constraint username_length check (char_length(username) >= 3)
);
ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;

-- Create entities table to match organizations
CREATE TABLE entities (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    description text,
    whatsapp_number text,
    address text,
    payment_failed BOOLEAN DEFAULT FALSE,
    payment_failed_at TIMESTAMP WITH TIME ZONE,
    created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create entity_members to match organization_members
CREATE TABLE entity_members (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    entity_id uuid REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(entity_id, profile_id)
);

-- Create entity_invites table
CREATE TABLE entity_invites (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    entity_id uuid REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    email text NOT NULL,
    invited_by uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    status text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined')) DEFAULT 'pending',
    created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Drop existing triggers and functions
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS handle_new_user();

-- Create function EXACTLY matching the original structure
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
   new_profile_id uuid;
   entity_id uuid;
   invite_exists boolean;
   proposed_username text;
   final_username text;
   username_counter integer := 1;
   username_exists boolean;
BEGIN
   -- Determine username: use provided username or extract from email
   proposed_username := COALESCE(
       NULLIF(trim(new.raw_user_meta_data->>'username'), ''),
       split_part(new.email, '@', 1)
   );
   
   -- Ensure username meets minimum length requirement (3 characters)
   IF char_length(proposed_username) < 3 THEN
       -- Pad with random numbers to meet minimum length
       proposed_username := proposed_username || lpad(
           floor(random() * 1000)::text, 
           3 - char_length(proposed_username), 
           '0'
       );
   END IF;
   
   -- Handle potential username conflicts
   final_username := proposed_username;
   
   LOOP
       SELECT EXISTS(
           SELECT 1 FROM public.profiles WHERE username = final_username
       ) INTO username_exists;
       
       IF NOT username_exists THEN
           EXIT;
       END IF;
       
       final_username := proposed_username || username_counter::text;
       username_counter := username_counter + 1;
   END LOOP;

   -- Create profile and get its ID
   INSERT INTO public.profiles (id, full_name, email, avatar_url, username)
   VALUES (
       new.id, 
       new.raw_user_meta_data->>'full_name', 
       new.email,
       new.raw_user_meta_data->>'avatar_url',
       final_username
   )
   RETURNING id INTO new_profile_id;
   
   -- Check if user has pending invites
   SELECT EXISTS(
       SELECT 1 FROM public.entity_invites 
       WHERE email = new.email AND status = 'pending'
   ) INTO invite_exists;
   
   IF NOT invite_exists THEN
       -- Create new entity (matching organization creation)
       INSERT INTO public.entities (name)
       VALUES (
           concat(
               initcap(split_part(new.email, '@', 1)),
               '''s Entity'
           )
       )
       RETURNING id INTO entity_id;
       
       -- Add user as owner (matching original)
       INSERT INTO public.entity_members (
           entity_id,
           profile_id,
           role
       )
       VALUES (
           entity_id,
           new_profile_id,
           'owner'
       );
   ELSE
       -- Accept pending invites
       UPDATE public.entity_invites 
       SET status = 'accepted', updated_at = now()
       WHERE email = new.email AND status = 'pending';
       
       -- Add user to entities they were invited to
       INSERT INTO public.entity_members (entity_id, profile_id, role)
       SELECT entity_id, new_profile_id, role
       FROM public.entity_invites
       WHERE email = new.email AND status = 'accepted';
   END IF;
   
   RETURN new;
EXCEPTION WHEN others THEN
   raise log 'Error in handle_new_user: %', SQLERRM;
   RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger exactly as original
CREATE TRIGGER on_auth_user_created
   AFTER INSERT ON auth.users
   FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();