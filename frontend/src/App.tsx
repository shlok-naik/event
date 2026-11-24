import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { RealtimeBridge } from './lib/realtime';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { Join, Login, Signup } from './pages/Auth';
import { Home } from './pages/Home';
import { Chat } from './pages/Chat';
import { GroupInfo, GroupNew, MapPage } from './pages/Groups';
import { EventNew, EventPage } from './pages/Events';
import { Integrations, Notifications, Profile, Tasks } from './pages/Me';
import { Empty } from './components/ui';

function Protected() {
  const { me, loading } = useAuth(); const loc = useLocation();
  if (loading) return <div className="center-screen"><Spinner /></div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <><RealtimeBridge /><Shell /></>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/join/:token" element={<Join />} />
      <Route element={<Protected />}>
        <Route index element={<Home />} />
        <Route path="map" element={<MapPage />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="me" element={<Profile />} />
        <Route path="integrations" element={<Integrations />} />
        <Route path="groups/new" element={<GroupNew />} />
        <Route path="groups/:id" element={<Chat />} />
        <Route path="groups/:id/info" element={<GroupInfo />} />
        <Route path="events/new" element={<EventNew />} />
        <Route path="events/:id" element={<EventPage />} />
        <Route path="*" element={<Empty icon="search" title="Page not found" />} />
      </Route>
    </Routes>
  );
}
