-- P4-04: Seed the api_permissions catalogue with the scopes used by the
-- public /v1 API surface.  These rows are reference data; they define the
-- valid scope codes that can be placed in api_tokens.scopes[].
--
-- The check constraint on api_tokens.scopes (jsonb_typeof = 'array') is
-- already in place from the foundation migration; the codes here simply
-- document the available options.
--
-- Scopes follow the pattern:  resource:action
-- Resources: documents, transactions, reports
-- Actions: read, write, delete, admin  (subset as applicable)

INSERT INTO api_permissions (code, resource, action, description)
VALUES
    ('documents:write',   'documents',    'write',  'Create documents via API (source=''api'')'),
    ('documents:read',    'documents',    'read',   'List and read documents'),
    ('transactions:read', 'transactions', 'read',   'List and read transactions'),
    ('reports:read',      'reports',      'read',   'Read generated reports')
ON CONFLICT (code) DO NOTHING;
