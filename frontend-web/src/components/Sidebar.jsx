import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useParsing } from '../context/ParsingContext';
import '../styles/Sidebar.css';
import { ICONS } from './Icons';

const Sidebar = ({
  isExpanded, onToggleExpand,
  user, toggleTheme, isDarkMode, onLogout, onOpenSettings
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { activeDoc, latestFinishedDocId } = useParsing();
  const [showPopup, setShowPopup] = useState(false);
  const popupRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        setShowPopup(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getInitials = () => {
    if (!user) return '?';
    const name = user.user_metadata?.full_name;
    if (name) {
      const parts = name.split(' ');
      return parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : parts[0][0].toUpperCase();
    }
    return user.email ? user.email[0].toUpperCase() + (user.email[1]?.toUpperCase() || '') : '?';
  };

  const getFullName = () => user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';

  const menuItems = [
    { path: '/',             label: 'Overview',      icon: <ICONS.Dashboard /> },
    { path: '/parsing',      label: 'Parsing',       icon: <ICONS.Upload /> },
    { path: '/transactions', label: 'Transactions',  icon: <ICONS.Transactions /> },
    { path: '/accounts',     label: 'Accounts',      icon: <ICONS.Accounts /> },
    { path: '/analytics',    label: 'Analytics',     icon: <ICONS.Analytics /> },
  ];

  // Show "Review" only if there is a document in context
  const urlDocId = new URLSearchParams(location.search).get('id');
  const currentDocId = latestFinishedDocId || activeDoc?.id || urlDocId;
  if (currentDocId) {
    menuItems.push({ 
        path: `/review?id=${currentDocId}`, 
        label: 'Review', 
        icon: <ICONS.Transactions />,
        isReview: true 
    });
  }

  const isActive = (path) => {
    if (path.startsWith('/review')) return location.pathname.startsWith('/review');
    return location.pathname === path;
  };

  return (
    <div className={`sidebar-container ${isExpanded ? 'expanded' : 'collapsed'}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
          <span className="logo-icon">▲</span>
          {!isExpanded && <ICONS.ArrowForward className="expand-icon" />}
          {isExpanded && <span className="logo-text">Ledger<span className="accent">AI</span></span>}
        </div>
        {isExpanded && (
          <button className="collapse-btn" onClick={onToggleExpand} style={{ padding: 0, background: 'none' }}>
            <ICONS.ArrowBack />
          </button>
        )}
      </div>

      <nav className="sidebar-nav">
        {menuItems.map(item => (
          <button
            key={item.path}
            className={`nav-item ${isActive(item.path) ? 'active' : ''}`}
            onClick={() => navigate(item.path)}
          >
            <span className="nav-icon">{item.icon}</span>
            {isExpanded && <span className="nav-label">{item.label}</span>}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer" ref={popupRef}>
        {showPopup && (
          <div className="profile-popup">
            <button className="popup-item" onClick={toggleTheme} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isDarkMode ? <ICONS.Sun /> : <ICONS.Moon />}
              <span>{isDarkMode ? 'Light' : 'Dark'} Mode</span>
            </button>
            <button className="popup-item" onClick={() => { navigate('/profile'); setShowPopup(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              <span>My Profile</span>
            </button>
            <button className="popup-item" onClick={() => { navigate('/settings'); setShowPopup(false); }} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ICONS.Settings />
              <span>Settings</span>
            </button>
            <button className="popup-item logout" onClick={onLogout} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ICONS.Logout />
              <span>Logout</span>
            </button>
          </div>
        )}

        <button
          className="nav-item footer-item profile-item"
          onClick={() => setShowPopup(!showPopup)}
        >
          <div className="profile-icon">{getInitials()}</div>
          {isExpanded && <span className="nav-label">{getFullName()}</span>}
        </button>
      </div>
    </div>
  );
};

export default Sidebar;