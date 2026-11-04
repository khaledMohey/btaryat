export const RETURNS_WAREHOUSE_CODE = 'RETURNS';
export const RETURNS_WAREHOUSE_NAME = 'مخزن المرتجعات';

export function isReturnsWarehouse(row: { code?: string | null; name?: string | null } | null | undefined) {
  if (!row) return false;
  return row.code === RETURNS_WAREHOUSE_CODE || row.name === RETURNS_WAREHOUSE_NAME;
}
