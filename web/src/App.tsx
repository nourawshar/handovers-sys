import { Navigate, Route, Routes } from 'react-router-dom'
import { HomeRedirect, RequireAuth, RequireRole } from '@/features/auth/auth'
import AppLayout from '@/components/layout/AppLayout'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import AssetListPage from '@/pages/assets/AssetListPage'
import PhonesPage from '@/pages/phones/PhonesPage'
import PhoneAssignPage from '@/pages/phones/assign/PhoneAssignPage'
import AssetFormPage from '@/pages/assets/AssetFormPage'
import AssetDetailPage from '@/pages/assets/AssetDetailPage'
import AccountsPage from '@/pages/AccountsPage'
import EmployeesPage from '@/pages/EmployeesPage'
import EmployeeDetailPage from '@/pages/EmployeeDetailPage'
import AssignmentDetailPage from '@/pages/assignments/AssignmentDetailPage'
import ReturnPage from '@/pages/assignments/ReturnPage'
import GenericAssignPage from '@/pages/assignments/GenericAssignPage'
import { AssignmentsPage, RoomsPage, WorkIdentitiesPage } from '@/pages/PeoplePages'
import CategoriesSettingsPage from '@/pages/settings/CategoriesSettingsPage'
import UsersSettingsPage from '@/pages/settings/UsersSettingsPage'
import ReportsPage from '@/pages/reports/ReportsPage'
import { Forbidden, NotFound } from '@/pages/Placeholders'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<HomeRedirect />} />
          <Route path="/dashboard" element={<DashboardPage />} />

          <Route path="/assets" element={<AssetListPage />} />
          <Route path="/assets/new" element={<RequireRole access="assets.new"><AssetFormPage /></RequireRole>} />
          <Route path="/assets/:id" element={<AssetDetailPage />} />
          <Route path="/assets/:id/timeline" element={<AssetDetailPage timelineOnly />} />
          <Route path="/assets/:id/edit" element={<RequireRole access="assets.edit"><AssetFormPage /></RequireRole>} />

          <Route path="/phones" element={<PhonesPage />} />
                    <Route path="/phones/assign" element={<RequireRole access="assets.new"><PhoneAssignPage /></RequireRole>} />

                    <Route path="/assignments" element={<AssignmentsPage />} />
                    <Route path="/assignments/new" element={<RequireRole access="assets.new"><GenericAssignPage /></RequireRole>} />
                    <Route path="/assignments/:id" element={<AssignmentDetailPage />} />
                    <Route path="/assignments/:id/return" element={<RequireRole access="assets.new"><ReturnPage /></RequireRole>} />

          <Route path="/accounts" element={<RequireRole access="accounts"><AccountsPage /></RequireRole>} />
          <Route path="/employees" element={<EmployeesPage />} />
          <Route path="/employees/:id" element={<EmployeeDetailPage />} />
          <Route path="/rooms" element={<RequireRole access="rooms"><RoomsPage /></RequireRole>} />
          <Route path="/work-identities" element={<RequireRole access="workIdentities"><WorkIdentitiesPage /></RequireRole>} />
          <Route path="/reports" element={<RequireRole access="reports"><ReportsPage /></RequireRole>} />
          <Route path="/settings/categories" element={<RequireRole access="settings.categories"><CategoriesSettingsPage /></RequireRole>} />
          <Route path="/settings/users" element={<RequireRole access="settings.users"><UsersSettingsPage /></RequireRole>} />

          <Route path="/forbidden" element={<Forbidden />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}
