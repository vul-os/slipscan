-- Create profiles table with email field
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

-- Function to handle new user creation, including email
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user creation
CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();