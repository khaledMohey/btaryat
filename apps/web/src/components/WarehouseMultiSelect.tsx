import { Check } from 'lucide-react';

type Warehouse = { id: string; name: string };

export function WarehouseMultiSelect({
  warehouses,
  value,
  onChange,
  hint = 'لو مفيش اختيار، يظهر للكل',
}: {
  warehouses: Warehouse[];
  value: string[];
  onChange: (ids: string[]) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-2.5 sm:grid-cols-2">
        {warehouses.length === 0 ? (
          <span className="px-1 text-xs text-muted">مفيش مخازن</span>
        ) : (
          warehouses.map((warehouse) => {
            const checked = value.includes(warehouse.id);
            return (
              <label
                key={warehouse.id}
                className={`flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[13px] font-bold transition ${
                  checked
                    ? 'border-brand-300 bg-brand-50 text-brand-800'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={(event) => {
                    onChange(
                      event.target.checked
                        ? [...value, warehouse.id]
                        : value.filter((id) => id !== warehouse.id),
                    );
                  }}
                />
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                    checked ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white'
                  }`}
                >
                  {checked && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="min-w-0 truncate" title={warehouse.name}>{warehouse.name}</span>
              </label>
            );
          })
        )}
      </div>
      {hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
