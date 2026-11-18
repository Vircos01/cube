import {
  updateModel,
  rollbackModel,
  deleteModel,
  restoreModel,
  cleanupArchivedRevisions,
  logAudit,
} from '../../src/repository/modelStore';
import { VersionConflictError } from '../../src/types';
import { Pool } from 'pg';

describe('Fase 4 — Optimistic Concurrency & Version Conflict Handling', () => {
  let mockPool: any;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'mock-audit' }] }),
    };
  });

  it('updateModel should succeed when expectedRevisionNumber matches active revision', async () => {
    const validYaml = `
cubes:
  - name: Orders
    sql_table: public.orders
    measures:
      - name: count
        type: count
`;
    // 1. BEGIN
    mockClient.query.mockResolvedValueOnce({});
    // 2. Lock model row
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'model-1', name: 'Orders', file_name: 'Orders.cube.yml', version: 2, is_active: true }],
    });
    // 3. Current active revision (revision_number: 2)
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'rev-2', model_id: 'model-1', revision_number: 2, status: 'active', content: validYaml }],
    });
    // 4. getActiveSchemaFiles
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    // 5. max revision number
    mockClient.query.mockResolvedValueOnce({ rows: [{ max_rev: '2' }] });
    // 6. archive current active
    mockClient.query.mockResolvedValueOnce({});
    // 7. insert new revision 3
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'rev-3', model_id: 'model-1', revision_number: 3, status: 'active', content: validYaml }],
    });
    // 8. update semantic_models (version = 3)
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'model-1', name: 'Orders', file_name: 'Orders.cube.yml', version: 3, is_active: true }],
    });
    // 9. logAudit
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1, action: 'UPDATE', result: 'SUCCESS' }] });
    // 10. bumpSchemaVersion
    mockClient.query.mockResolvedValueOnce({ rows: [{ version: 5, version_hash: 'abc12345' }] });
    // 11. fetch all revisions
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'rev-3', revision_number: 3 }] });
    // 12. COMMIT
    mockClient.query.mockResolvedValueOnce({});

    const result = await updateModel(mockPool as Pool, 'model-1', {
      content: validYaml,
      expectedRevisionNumber: 2,
      actor: 'admin_user',
      source: 'web_ui',
      change_summary: 'Updated orders cube',
    });

    expect(result.id).toBe('model-1');
    expect(result.active_revision?.revision_number).toBe(3);
  });

  it('updateModel should throw VersionConflictError and log FAILED audit when expectedRevisionNumber does not match', async () => {
    // 1. BEGIN
    mockClient.query.mockResolvedValueOnce({});
    // 2. Lock model row
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'model-1', name: 'Orders', file_name: 'Orders.cube.yml', version: 3, is_active: true }],
    });
    // 3. Current active revision has already been bumped to revision 3!
    mockClient.query.mockResolvedValueOnce({
      rows: [{
        id: 'rev-3',
        model_id: 'model-1',
        revision_number: 3,
        status: 'active',
        change_summary: 'Concurrent edit by colleague',
        created_by: 'other_admin',
      }],
    });
    // 4. logAudit for FAILED attempt
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1, action: 'UPDATE', result: 'FAILED' }] });
    // 5. ROLLBACK
    mockClient.query.mockResolvedValueOnce({});

    await expect(
      updateModel(mockPool as Pool, 'model-1', {
        content: 'content',
        expectedRevisionNumber: 2, // Client still thinks it was revision 2!
        actor: 'user_a',
      })
    ).rejects.toThrow(VersionConflictError);

    // Verify that FAILED audit entry was logged outside transaction
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['UPDATE', 'model-1', 'Orders', 'rev-3', null])
    );
  });
});

describe('Fase 4 — Validated Rollback, Soft-Delete & Restore', () => {
  let mockPool: any;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [{ id: 'mock-audit' }] }),
    };
  });

  it('rollbackModel should pre-validate target content and reject if invalid syntax', async () => {
    // 1. BEGIN
    mockClient.query.mockResolvedValueOnce({});
    // 2. Lock model
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'model-1', name: 'Orders', file_name: 'Orders.cube.yml', is_active: true }],
    });
    // 3. Current active revision
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 'rev-3', revision_number: 3, status: 'active' }],
    });
    // 4. Fetch target revision (which has corrupted syntax)
    mockClient.query.mockResolvedValueOnce({
      rows: [{
        id: 'rev-1',
        model_id: 'model-1',
        revision_number: 1,
        content: 'corrupt: yaml: [invalid',
        content_format: 'yaml',
      }],
    });
    // 5. getActiveSchemaFiles
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    // 6. logAudit FAILED
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 1, action: 'ROLLBACK', result: 'FAILED' }] });
    // 7. ROLLBACK transaction
    mockClient.query.mockResolvedValueOnce({});

    await expect(
      rollbackModel(mockPool as Pool, 'model-1', 1, 'admin', 'web_ui')
    ).rejects.toThrow(/Rollback validatie mislukt/);
  });

  it('deleteModel should perform soft delete and log audit', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'Orders', is_active: true }] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: 'rev-1', status: 'active' }] }) // active rev
      .mockResolvedValueOnce({}) // update semantic_models is_active = false
      .mockResolvedValueOnce({}) // update model_revisions status = archived
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // audit log
      .mockResolvedValueOnce({ rows: [{ version: 2, version_hash: '123' }] }) // bumpSchemaVersion
      .mockResolvedValueOnce({}); // COMMIT

    await deleteModel(mockPool as Pool, 'model-1', 'admin_user', 'web_ui');

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE semantic_models\n      SET is_active = false'),
      ['model-1']
    );
  });

  it('restoreModel should reactivate model and its latest revision', async () => {
    const validYaml = `
cubes:
  - name: Orders
    sql_table: public.orders
    measures:
      - name: count
        type: count
`;
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'Orders', file_name: 'Orders.cube.yml', is_active: false }] }) // lock (inactive)
      .mockResolvedValueOnce({ rows: [{ id: 'rev-2', model_id: 'model-1', revision_number: 2, content: validYaml, content_format: 'yaml' }] }) // latest rev
      .mockResolvedValueOnce({ rows: [] }) // getActiveSchemaFiles
      .mockResolvedValueOnce({}) // update model_revisions status = active
      .mockResolvedValueOnce({ rows: [{ id: 'model-1', name: 'Orders', is_active: true, version: 3 }] }) // reactivate model
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // logAudit
      .mockResolvedValueOnce({ rows: [{ version: 4, version_hash: '456' }] }) // bumpSchemaVersion
      .mockResolvedValueOnce({ rows: [{ id: 'rev-2', revision_number: 2, status: 'active' }] }) // all revisions
      .mockResolvedValueOnce({}); // COMMIT

    const restored = await restoreModel(mockPool as Pool, 'model-1', 'admin_user', 'web_ui');
    expect(restored.is_active).toBe(true);
    expect(restored.active_revision?.revision_number).toBe(2);
  });

  it('cleanupArchivedRevisions should purge old revisions while preserving minimum N', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'old-rev-1' }, { id: 'old-rev-2' }] }) // DELETE CTE
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // logAudit
      .mockResolvedValueOnce({}); // COMMIT

    const result = await cleanupArchivedRevisions(mockPool as Pool, {
      retentionDays: 60,
      keepMinRevisions: 3,
      actor: 'maintenance_cron',
    });

    expect(result.deletedCount).toBe(2);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM model_revisions'),
      [3, 60]
    );
  });
});

describe('Fase 4 — Audit Logging Compliance', () => {
  it('logAudit should record actor, source, result, model, and previous/current revision', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValueOnce({
        rows: [{
          id: 42,
          action: 'UPDATE',
          model_id: 'm-1',
          model_name: 'Orders',
          previous_revision_id: 'rev-1',
          revision_id: 'rev-2',
          actor: 'alice',
          source: 'web_ui',
          result: 'SUCCESS',
          created_at: new Date(),
        }],
      }),
    };

    const entry = await logAudit(mockClient as any, {
      action: 'UPDATE',
      model_id: 'm-1',
      model_name: 'Orders',
      previous_revision_id: 'rev-1',
      revision_id: 'rev-2',
      actor: 'alice',
      source: 'web_ui',
      result: 'SUCCESS',
      details: { note: 'compliance test' },
    });

    expect(entry.id).toBe(42);
    expect(entry.actor).toBe('alice');
    expect(entry.source).toBe('web_ui');
    expect(entry.result).toBe('SUCCESS');
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['UPDATE', 'm-1', 'Orders', 'rev-1', 'rev-2', '{"note":"compliance test"}', 'alice', 'web_ui', 'SUCCESS', null, null])
    );
  });
});
