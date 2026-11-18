-- Sample Data Sources for Cube & Apache Superset Demo

CREATE TABLE IF NOT EXISTS sample_users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    gender VARCHAR(20),
    city VARCHAR(100),
    country VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days'
);

CREATE TABLE IF NOT EXISTS sample_products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(100) NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() - INTERVAL '60 days'
);

CREATE TABLE IF NOT EXISTS sample_orders (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES sample_users(id),
    status VARCHAR(50) NOT NULL, -- 'completed', 'processing', 'shipped', 'cancelled'
    amount NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert sample users
INSERT INTO sample_users (id, name, email, gender, city, country, created_at) VALUES
(1, 'Alice Johnson', 'alice@example.com', 'female', 'Amsterdam', 'Netherlands', NOW() - INTERVAL '25 days'),
(2, 'Bob Smith', 'bob@example.com', 'male', 'Rotterdam', 'Netherlands', NOW() - INTERVAL '20 days'),
(3, 'Charlie Brown', 'charlie@example.com', 'male', 'Utrecht', 'Netherlands', NOW() - INTERVAL '15 days'),
(4, 'Diana Prince', 'diana@example.com', 'female', 'Eindhoven', 'Netherlands', NOW() - INTERVAL '10 days'),
(5, 'Edward Davis', 'edward@example.com', 'male', 'The Hague', 'Netherlands', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- Insert sample products
INSERT INTO sample_products (id, name, category, price, created_at) VALUES
(1, 'Ergonomic Chair', 'Furniture', 199.99, NOW() - INTERVAL '50 days'),
(2, 'Standing Desk', 'Furniture', 349.50, NOW() - INTERVAL '45 days'),
(3, 'Mechanical Keyboard', 'Electronics', 129.00, NOW() - INTERVAL '40 days'),
(4, 'Ultra-wide Monitor', 'Electronics', 499.00, NOW() - INTERVAL '35 days'),
(5, 'Wireless Mouse', 'Electronics', 49.99, NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

-- Insert sample orders
INSERT INTO sample_orders (id, user_id, status, amount, created_at) VALUES
(1, 1, 'completed', 349.50, NOW() - INTERVAL '24 days'),
(2, 1, 'completed', 49.99, NOW() - INTERVAL '20 days'),
(3, 2, 'completed', 199.99, NOW() - INTERVAL '18 days'),
(4, 3, 'processing', 628.00, NOW() - INTERVAL '5 days'),
(5, 4, 'shipped', 499.00, NOW() - INTERVAL '3 days'),
(6, 2, 'cancelled', 129.00, NOW() - INTERVAL '2 days'),
(7, 5, 'completed', 399.98, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Seed initial semantic models into PostgreSQL metadata
DO $$
DECLARE
    orders_model_id UUID;
    users_model_id UUID;
    v_version BIGINT;
BEGIN
    -- 1. Orders Cube
    INSERT INTO semantic_models (name, model_type, file_name, description, is_active)
    VALUES (
        'Orders',
        'cube',
        'Orders.cube.yml',
        'Semantic cube for e-commerce orders and revenue analytics',
        true
    )
    ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
    RETURNING id INTO orders_model_id;

    INSERT INTO model_revisions (model_id, revision_number, content, content_format, change_summary, status, created_by)
    VALUES (
        orders_model_id,
        1,
'cubes:
  - name: Orders
    sql_table: public.sample_orders
    
    joins:
      - name: Users
        sql: "{CUBE}.user_id = {Users.id}"
        relationship: many_to_one

    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true

      - name: status
        sql: status
        type: string

      - name: created_at
        sql: created_at
        type: time

    measures:
      - name: count
        type: count

      - name: total_amount
        sql: amount
        type: sum

      - name: avg_order_value
        sql: amount
        type: avg
',
        'yaml',
        'Initial model creation for Orders cube',
        'active',
        'system'
    )
    ON CONFLICT (model_id, revision_number) DO NOTHING;

    -- 2. Users Cube
    INSERT INTO semantic_models (name, model_type, file_name, description, is_active)
    VALUES (
        'Users',
        'cube',
        'Users.cube.yml',
        'Semantic cube for customer and user analytics',
        true
    )
    ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
    RETURNING id INTO users_model_id;

    INSERT INTO model_revisions (model_id, revision_number, content, content_format, change_summary, status, created_by)
    VALUES (
        users_model_id,
        1,
'cubes:
  - name: Users
    sql_table: public.sample_users

    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true

      - name: name
        sql: name
        type: string

      - name: email
        sql: email
        type: string

      - name: city
        sql: city
        type: string

      - name: country
        sql: country
        type: string

      - name: created_at
        sql: created_at
        type: time

    measures:
      - name: count
        type: count
',
        'yaml',
        'Initial model creation for Users cube',
        'active',
        'system'
    )
    ON CONFLICT (model_id, revision_number) DO NOTHING;

    -- Update tracker version
    UPDATE schema_version_tracker 
    SET version = version + 1, version_hash = md5(random()::text), updated_at = NOW()
    WHERE id = 1;

END $$;
