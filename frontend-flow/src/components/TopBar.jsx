/**
 * Topbar — used at the top of every protected page.
 *
 * Usage inside a page:
 *   import Topbar from '../components/Topbar';
 *   import { useOutletContext } from 'react-router-dom';
 *
 *   const { openSidebar } = useOutletContext();
 *   <Topbar title="Dashboard" sub="Mon, 18 Apr 2026" onMenuClick={openSidebar}>
 *     <button className="btn btn-primary">New Invoice</button>
 *   </Topbar>
 */

export default function Topbar({ title, sub, onMenuClick, children }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        {/* Hamburger — visible on mobile only (CSS hides on desktop) */}
        <button
          className="menu-btn"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
        >
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
        </button>

        <div>
          <div className="topbar-title">{title}</div>
          {sub && <div className="topbar-sub">{sub}</div>}
        </div>
      </div>

      {children && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {children}
        </div>
      )}
    </div>
  );
}
