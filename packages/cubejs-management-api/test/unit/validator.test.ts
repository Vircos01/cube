import { validateSchemaContent } from '../../src/compiler/validator';

describe('Schema Validator', () => {
  it('successfully validates a valid Cube YAML schema', async () => {
    const yaml = `
cubes:
  - name: Orders
    sql_table: public.orders

    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true

      - name: status
        sql: status
        type: string

    measures:
      - name: count
        type: count
`;

    const result = await validateSchemaContent(yaml, 'Orders.cube.yml');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cubes.length).toBeGreaterThanOrEqual(1);
      const ordersCube = result.cubes.find(c => c.name === 'Orders');
      expect(ordersCube).toBeDefined();
    }
  });

  it('fails with line and column for invalid YAML syntax', async () => {
    const brokenYaml = `
cubes:
  - name: Orders
    sql_table: public.orders
    dimensions:
      - name: id
        sql: id
       type: number -- bad indentation
`;

    const result = await validateSchemaContent(brokenYaml, 'Broken.cube.yml');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe('YAML_SYNTAX_ERROR');
      expect(result.errors[0].line).toBeDefined();
    }
  });

  it('catches semantic errors like duplicate measures', async () => {
    const duplicateMeasuresYaml = `
cubes:
  - name: Orders
    sql_table: public.orders

    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true

    measures:
      - name: count
        type: count

      - name: count
        type: count
`;

    const result = await validateSchemaContent(duplicateMeasuresYaml, 'Duplicate.cube.yml');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("Found duplicate measure 'count'");
    }
  });

  it('validates joins between multiple cubes', async () => {
    const usersYaml = `
cubes:
  - name: Users
    sql_table: public.users
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
`;

    const ordersYaml = `
cubes:
  - name: Orders
    sql_table: public.orders
    joins:
      - name: Users
        sql: "{CUBE}.user_id = {Users.id}"
        relationship: many_to_one
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
`;

    const existingFiles = [{ fileName: 'Users.cube.yml', content: usersYaml }];
    const result = await validateSchemaContent(ordersYaml, 'Orders.cube.yml', existingFiles);
    expect(result.valid).toBe(true);
  });
});
