import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { NAV_ITEMS } from './lib/nav';
import { AppLayout } from './components/AppLayout';
import { PageSkeleton } from './components/ui';
import { LoginPage } from './pages/LoginPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const WarehousesPage = lazy(() => import('./pages/WarehousesPage').then((m) => ({ default: m.WarehousesPage })));
const ProductsPage = lazy(() => import('./pages/ProductsPage').then((m) => ({ default: m.ProductsPage })));
const SuppliersPage = lazy(() => import('./pages/SuppliersPage').then((m) => ({ default: m.SuppliersPage })));
const CustomersPage = lazy(() => import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const CashPage = lazy(() => import('./pages/CashPage').then((m) => ({ default: m.CashPage })));
const SalesPage = lazy(() => import('./pages/SalesPage').then((m) => ({ default: m.SalesPage })));
const PurchasesPage = lazy(() => import('./pages/PurchasesPage').then((m) => ({ default: m.PurchasesPage })));
const ReturnsPage = lazy(() => import('./pages/ReturnsPage').then((m) => ({ default: m.ReturnsPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const StockPage = lazy(() => import('./pages/StockPage').then((m) => ({ default: m.StockPage })));
const FinancePage = lazy(() => import('./pages/FinancePage').then((m) => ({ default: m.FinancePage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const InsightsPage = lazy(() => import('./pages/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const ReportBuilderPage = lazy(() => import('./pages/ReportBuilderPage').then((m) => ({ default: m.ReportBuilderPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

function PageGuard({ page, children }: { page: string; children: React.ReactNode }) {
  const { user } = useAuth();
  if (user?.access && !user.access[page]?.view) {
    const next = NAV_ITEMS.find((item) => user.access?.[item.page]?.view);
    return <Navigate to={next?.to || '/login'} replace />;
  }
  return <>{children}</>;
}

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageSkeleton />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <AppLayout />
            </PrivateRoute>
          }
        >
          <Route index element={<PageGuard page="dashboard"><DashboardPage /></PageGuard>} />
          <Route path="warehouses" element={<PageGuard page="warehouses"><WarehousesPage /></PageGuard>} />
          <Route path="products" element={<PageGuard page="products"><ProductsPage /></PageGuard>} />
          <Route path="stock" element={<PageGuard page="stock"><StockPage /></PageGuard>} />
          <Route path="suppliers" element={<PageGuard page="suppliers"><SuppliersPage /></PageGuard>} />
          <Route path="customers" element={<PageGuard page="customers"><CustomersPage /></PageGuard>} />
          <Route path="cash" element={<PageGuard page="cash"><CashPage /></PageGuard>} />
          <Route path="sales" element={<PageGuard page="sales"><SalesPage /></PageGuard>} />
          <Route path="purchases" element={<PageGuard page="purchases"><PurchasesPage /></PageGuard>} />
          <Route path="returns" element={<PageGuard page="returns"><ReturnsPage /></PageGuard>} />
          <Route path="documents" element={<Navigate to="/sales" replace />} />
          <Route path="finance" element={<PageGuard page="finance"><FinancePage /></PageGuard>} />
          <Route path="reports" element={<PageGuard page="reports"><ReportsPage /></PageGuard>} />
          <Route path="analytics" element={<PageGuard page="analytics"><AnalyticsPage /></PageGuard>} />
          <Route path="insights" element={<PageGuard page="insights"><InsightsPage /></PageGuard>} />
          <Route path="audit" element={<PageGuard page="audit"><AuditPage /></PageGuard>} />
          <Route path="organization" element={<Navigate to="/" replace />} />
          <Route path="import" element={<Navigate to="/products" replace />} />
          <Route path="permissions" element={<Navigate to="/" replace />} />
          <Route path="report-builder" element={<PageGuard page="reportBuilder"><ReportBuilderPage /></PageGuard>} />
          <Route path="tasks" element={<Navigate to="/" replace />} />
          <Route path="automation" element={<Navigate to="/" replace />} />
          <Route path="settings" element={<PageGuard page="settings"><SettingsPage /></PageGuard>} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
