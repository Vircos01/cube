"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserByUsername = getUserByUsername;
exports.listUsers = listUsers;
exports.upsertUser = upsertUser;
exports.deleteUser = deleteUser;
exports.listRoles = listRoles;
exports.upsertRole = upsertRole;
exports.listPolicies = listPolicies;
exports.upsertPolicy = upsertPolicy;
exports.deletePolicy = deletePolicy;
const password_1 = require("../security/password");
// ================= USER ACCOUNTS =================
async function getUserByUsername(pool, username) {
    const res = await pool.query(`
    SELECT u.*, r.is_admin
    FROM user_accounts u
    JOIN security_roles r ON u.role_id = r.name
    WHERE u.username = $1 AND u.is_active = true
  `, [username]);
    if (res.rows.length === 0) {
        return null;
    }
    return res.rows[0];
}
async function listUsers(pool) {
    const res = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.email, u.role_id, u.claims, u.is_active, u.created_at, u.updated_at, r.display_name as role_display_name
    FROM user_accounts u
    JOIN security_roles r ON u.role_id = r.name
    ORDER BY u.username ASC
  `);
    return res.rows;
}
async function upsertUser(pool, input) {
    const claims = input.claims || {};
    const isActive = input.is_active !== false;
    let query;
    let params;
    if (input.password && input.password.trim().length > 0) {
        const hashed = (0, password_1.hashPassword)(input.password);
        query = `
      INSERT INTO user_accounts (username, password_hash, display_name, email, role_id, claims, is_active, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (username) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        role_id = EXCLUDED.role_id,
        claims = EXCLUDED.claims,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING id, username, display_name, email, role_id, claims, is_active, created_at, updated_at
    `;
        params = [input.username, hashed, input.display_name, input.email || null, input.role_id, JSON.stringify(claims), isActive];
    }
    else {
        query = `
      INSERT INTO user_accounts (username, password_hash, display_name, email, role_id, claims, is_active, updated_at)
      VALUES ($1, 'changeme', $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (username) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        role_id = EXCLUDED.role_id,
        claims = EXCLUDED.claims,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING id, username, display_name, email, role_id, claims, is_active, created_at, updated_at
    `;
        params = [input.username, input.display_name, input.email || null, input.role_id, JSON.stringify(claims), isActive];
    }
    const res = await pool.query(query, params);
    return res.rows[0];
}
async function deleteUser(pool, idOrUsername) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrUsername);
    const query = isUuid
        ? 'UPDATE user_accounts SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id'
        : 'UPDATE user_accounts SET is_active = false, updated_at = NOW() WHERE username = $1 RETURNING id';
    const res = await pool.query(query, [idOrUsername]);
    return res.rows.length > 0;
}
// ================= SECURITY ROLES & POLICIES =================
async function listRoles(pool) {
    const rolesRes = await pool.query('SELECT * FROM security_roles ORDER BY name ASC');
    const policiesRes = await pool.query('SELECT * FROM access_policies WHERE is_active = true ORDER BY cube_name ASC');
    const policiesByRole = new Map();
    for (const pol of policiesRes.rows) {
        if (!policiesByRole.has(pol.role_id)) {
            policiesByRole.set(pol.role_id, []);
        }
        policiesByRole.get(pol.role_id).push(pol);
    }
    return rolesRes.rows.map(r => ({
        ...r,
        policies: policiesByRole.get(r.name) || [],
    }));
}
async function upsertRole(pool, input) {
    const res = await pool.query(`
    INSERT INTO security_roles (name, display_name, description, is_admin, can_manage_models, can_manage_datasources, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (name) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      is_admin = EXCLUDED.is_admin,
      can_manage_models = EXCLUDED.can_manage_models,
      can_manage_datasources = EXCLUDED.can_manage_datasources,
      updated_at = NOW()
    RETURNING *
  `, [
        input.name,
        input.display_name,
        input.description || null,
        !!input.is_admin,
        !!input.can_manage_models,
        !!input.can_manage_datasources,
    ]);
    return res.rows[0];
}
async function listPolicies(pool, roleId) {
    let query = 'SELECT * FROM access_policies WHERE is_active = true';
    const params = [];
    if (roleId) {
        query += ' AND role_id = $1';
        params.push(roleId);
    }
    query += ' ORDER BY role_id ASC, cube_name ASC';
    const res = await pool.query(query, params);
    return res.rows;
}
async function upsertPolicy(pool, input) {
    if (input.id) {
        const res = await pool.query(`
      UPDATE access_policies
      SET role_id = $2,
          cube_name = $3,
          policy_type = $4,
          definition = $5,
          is_active = true,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [input.id, input.role_id, input.cube_name, input.policy_type, JSON.stringify(input.definition)]);
        return res.rows[0];
    }
    const res = await pool.query(`
    INSERT INTO access_policies (role_id, cube_name, policy_type, definition, is_active, updated_at)
    VALUES ($1, $2, $3, $4, true, NOW())
    RETURNING *
  `, [input.role_id, input.cube_name, input.policy_type, JSON.stringify(input.definition)]);
    return res.rows[0];
}
async function deletePolicy(pool, id) {
    const res = await pool.query('DELETE FROM access_policies WHERE id = $1 RETURNING id', [id]);
    return res.rows.length > 0;
}
//# sourceMappingURL=securityStore.js.map