import { hashPassword, verifyPassword } from '../../src/security/password';
import {
  getUserByUsername,
  listUsers,
  upsertUser,
  deleteUser,
  listRoles,
  upsertRole,
  listPolicies,
  upsertPolicy,
  deletePolicy,
} from '../../src/repository/securityStore';
import { createManagementRouter } from '../../src/api/router';
import { Pool } from 'pg';

describe('Security - Password Hashing & Verification', () => {
  it('should hash password with scrypt and verify successfully', () => {
    const raw = 'SuperSecret123!';
    const hashed = hashPassword(raw);

    expect(hashed).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(verifyPassword(raw, hashed)).toBe(true);
    expect(verifyPassword('WrongPassword', hashed)).toBe(false);
  });

  it('should support plain fallback comparison for legacy/seed passwords', () => {
    expect(verifyPassword('admin', 'admin')).toBe(true);
    expect(verifyPassword('amsterdam123', 'amsterdam123')).toBe(true);
    expect(verifyPassword('wrong', 'admin')).toBe(false);
  });

  it('should return false for invalid or corrupt hashes', () => {
    expect(verifyPassword('test', '')).toBe(false);
    expect(verifyPassword('test', 'scrypt:corrupt')).toBe(false);
    expect(verifyPassword('test', 'scrypt:salt:notvalidhex')).toBe(false);
  });
});

describe('Security Store CRUD', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    };
  });

  it('getUserByUsername should query user_accounts and return user with role info', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          username: 'sales_amsterdam',
          password_hash: 'scrypt:salt:hash',
          display_name: 'Sales Rep Amsterdam',
          role_id: 'sales_rep',
          claims: { city: 'Amsterdam' },
          is_active: true,
          is_admin: false,
        },
      ],
    });

    const user = await getUserByUsername(mockPool as Pool, 'sales_amsterdam');
    expect(user).not.toBeNull();
    expect(user?.username).toBe('sales_amsterdam');
    expect(user?.claims).toEqual({ city: 'Amsterdam' });
    expect(user?.is_admin).toBe(false);
  });

  it('listUsers should query active users with roles', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-1',
          username: 'admin',
          display_name: 'Global Administrator',
          role_id: 'admin',
          claims: {},
          is_active: true,
        },
      ],
    });

    const users = await listUsers(mockPool as Pool);
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('admin');
  });

  it('upsertUser should hash password when provided', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'user-2',
          username: 'new_rep',
          display_name: 'New Representative',
          role_id: 'sales_rep',
          claims: { city: 'Utrecht' },
          is_active: true,
        },
      ],
    });

    const user = await upsertUser(mockPool as Pool, {
      username: 'new_rep',
      password: 'mypassword123',
      display_name: 'New Representative',
      role_id: 'sales_rep',
      claims: { city: 'Utrecht' },
    });

    expect(user.username).toBe('new_rep');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe('new_rep');
    expect(params[1]).toMatch(/^scrypt:/); // hashed password
    expect(params[4]).toBe('sales_rep');
  });

  it('deleteUser should soft delete user', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    const success = await deleteUser(mockPool as Pool, 'sales_amsterdam');
    expect(success).toBe(true);
  });

  it('listRoles should join roles with policies', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ name: 'sales_rep', display_name: 'Sales Rep' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'pol-1',
            role_id: 'sales_rep',
            cube_name: 'Orders',
            policy_type: 'RLS',
            definition: { member: 'Users.city', operator: 'equals', claimField: 'city' },
          },
        ],
      });

    const roles = await listRoles(mockPool as Pool);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe('sales_rep');
    expect(roles[0].policies).toHaveLength(1);
    expect(roles[0].policies[0].policy_type).toBe('RLS');
  });

  it('upsertPolicy should insert new policy when id is omitted', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'pol-2',
          role_id: 'sales_rep',
          cube_name: 'Orders',
          policy_type: 'OLS',
          definition: { denyMeasures: ['Orders.avg_order_value'] },
        },
      ],
    });

    const pol = await upsertPolicy(mockPool as Pool, {
      role_id: 'sales_rep',
      cube_name: 'Orders',
      policy_type: 'OLS',
      definition: { denyMeasures: ['Orders.avg_order_value'] },
    });

    expect(pol.id).toBe('pol-2');
    expect(pol.policy_type).toBe('OLS');
  });
});

describe('Production Secret Safety Enforcement', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('should throw an error in production if default secret mysecretkey123 is used', () => {
    process.env.NODE_ENV = 'production';
    const mockPool = {} as Pool;

    expect(() => {
      createManagementRouter(mockPool, { apiSecret: 'mysecretkey123' });
    }).toThrow(/Productie-omgeving gedetecteerd.*standaard wachtwoord/);
  });

  it('should allow startup in production if secure non-default secret is configured', () => {
    process.env.NODE_ENV = 'production';
    const mockPool = {} as Pool;

    expect(() => {
      createManagementRouter(mockPool, { apiSecret: 'x9f2A#k9L!secure_prod_secret_9981' });
    }).not.toThrow();
  });
});
