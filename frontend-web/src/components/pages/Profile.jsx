import React, { useState, useEffect } from 'react';
import { supabase } from '../../shared/supabase';
import { useUser } from '../../context/UserContext';
import { ICONS } from '../Icons';
import '../../styles/Profile.css';

const Profile = () => {
  const user = useUser();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({ banks: false, cards: false, wallets: false });
  
  const [profileData, setProfileData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    profileType: '',
    setupName: '',
    avatarUrl: '',
    accounts: []
  });

  const [editForm, setEditForm] = useState({
    firstName: '',
    lastName: ''
  });

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      setLoading(true);
      if (!user) return;

      const fullName = user.user_metadata?.full_name || '';
      const nameParts = fullName.split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      const avatarUrl = user.user_metadata?.avatar_url || '';

      const { data: userMods } = await supabase
        .from('user_modules')
        .select('module_id, coa_modules(module_name, category)')
        .eq('user_id', user.id);

      const specificSetup = userMods?.find(m => m.coa_modules.module_name !== 'Core');
      const profileType = specificSetup?.coa_modules?.category || 'INDIVIDUAL';
      const setupName = specificSetup?.coa_modules?.module_name || 'Standard';

      const { data: accs } = await supabase
        .from('accounts')
        .select(`
          account_id, 
          account_name, 
          account_type,
          account_identifiers!inner(
            institution_name,
            account_number_last4,
            card_last4,
            wallet_id
          )
        `)
        .eq('user_id', user.id);

      const data = {
        firstName,
        lastName,
        email: user.email || '',
        profileType: profileType === 'INDIVIDUAL' ? 'Individual' : 'Business',
        setupName,
        avatarUrl,
        accounts: accs || []
      };

      setProfileData(data);
      setEditForm({ firstName, lastName });

    } catch (err) {
      console.error('Error fetching profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveInfo = async () => {
    try {
      setSaving(true);
      const newFullName = `${editForm.firstName} ${editForm.lastName}`.trim();
      const { error } = await supabase.auth.updateUser({
        data: { full_name: newFullName }
      });

      if (error) throw error;

      setProfileData(prev => ({
        ...prev,
        firstName: editForm.firstName,
        lastName: editForm.lastName
      }));
      setIsEditing(false);
    } catch (err) {
      console.error('Error saving profile:', err);
      alert('Failed to save changes.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="profile-loading">
        <span className="spinner"></span>
      </div>
    );
  }

  const getInitials = () => {
    return (profileData.firstName[0] || 'U').toUpperCase() + (profileData.lastName[0] || '').toUpperCase();
  };

  const toggleGroup = (group) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const banks = profileData.accounts.filter(a => a.account_identifiers[0].account_number_last4 != null);
  const cards = profileData.accounts.filter(a => a.account_identifiers[0].card_last4 != null);
  const wallets = profileData.accounts.filter(a => a.account_identifiers[0].wallet_id != null);

  return (
    <div className="profile-container">
      <div className="page-header">
        <div className="header-title">
          <h1>My Profile</h1>
          <p>Manage your personal information and linked accounts.</p>
        </div>
      </div>

      <div className="profile-header-compact">
        <div className="avatar-wrapper compact readonly">
          <div className="profile-avatar-large">
            {profileData.avatarUrl ? (
              <img src={profileData.avatarUrl} alt="Profile" />
            ) : (
              <span className="avatar-initials">{getInitials()}</span>
            )}
          </div>
        </div>
        <div className="profile-hero-info">
          <h1 className="hero-name">{profileData.firstName} {profileData.lastName}</h1>
          <p className="profile-tagline">{profileData.setupName} • {profileData.profileType}</p>
        </div>
      </div>

      <div className="profile-content-grid">
        <div className="profile-card">
          <div className="card-header">
            <h2>Personal Information</h2>
            {!isEditing ? (
              <button className="edit-profile-btn" onClick={() => setIsEditing(true)}>
                <ICONS.Edit /> Edit
              </button>
            ) : (
              <div className="edit-actions">
                <button className="cancel-edit-btn" onClick={() => setIsEditing(false)}>Cancel</button>
                <button className="save-edit-btn" onClick={handleSaveInfo} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>
          <div className="card-body">
            <div className="info-grid">
              <div className="info-item">
                <label>First Name</label>
                {isEditing ? (
                  <input type="text" className="profile-input" value={editForm.firstName} onChange={e => setEditForm(p => ({ ...p, firstName: e.target.value }))} />
                ) : (
                  <div className="info-value">{profileData.firstName}</div>
                )}
              </div>
              <div className="info-item">
                <label>Last Name</label>
                {isEditing ? (
                  <input type="text" className="profile-input" value={editForm.lastName} onChange={e => setEditForm(p => ({ ...p, lastName: e.target.value }))} />
                ) : (
                  <div className="info-value">{profileData.lastName}</div>
                )}
              </div>
              
              {/* System Locked Fields */}
              <div className="info-item full-width locked">
                <div className="locked-label">System Locked</div>
                <label>Email Address</label>
                <div className="info-value email-value">{profileData.email}</div>
              </div>
              
              <div className="info-item locked">
                <div className="locked-label">System Locked</div>
                <label>Profile Type</label>
                <div className="info-value static-value">{profileData.profileType}</div>
              </div>
              
              <div className="info-item locked">
                <div className="locked-label">System Locked</div>
                <label>Specific Setup</label>
                <div className="info-value static-value">{profileData.setupName}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="profile-card">
          <div className="card-header">
            <h2>Linked Accounts</h2>
          </div>
          <div className="card-body accounts-body">
            {profileData.accounts.length === 0 ? (
              <div className="no-data-msg"><p>No accounts linked yet.</p></div>
            ) : (
              <div className="accounts-tree">
                {banks.length > 0 && (
                  <div className="tree-group">
                    <button className="tree-header" onClick={() => toggleGroup('banks')}>
                      <span className={`chevron ${expandedGroups.banks ? 'open' : ''}`}>▼</span>
                      <span className="group-label">Bank Accounts</span>
                    </button>
                    {expandedGroups.banks && (
                      <div className="tree-children">
                        {banks.map(acc => (
                          <AccountItem key={acc.account_id} acc={acc} icon="🏦" />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {cards.length > 0 && (
                  <div className="tree-group">
                    <button className="tree-header" onClick={() => toggleGroup('cards')}>
                      <span className={`chevron ${expandedGroups.cards ? 'open' : ''}`}>▼</span>
                      <span className="group-label">Credit Cards</span>
                    </button>
                    {expandedGroups.cards && (
                      <div className="tree-children">
                        {cards.map(acc => (
                          <AccountItem key={acc.account_id} acc={acc} icon="💳" />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {wallets.length > 0 && (
                  <div className="tree-group">
                    <button className="tree-header" onClick={() => toggleGroup('wallets')}>
                      <span className={`chevron ${expandedGroups.wallets ? 'open' : ''}`}>▼</span>
                      <span className="group-label">Cash / Wallets</span>
                    </button>
                    {expandedGroups.wallets && (
                      <div className="tree-children">
                        {wallets.map(acc => (
                          <AccountItem key={acc.account_id} acc={acc} icon="👛" />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const AccountItem = ({ acc, icon }) => {
  const ident = acc.account_identifiers[0];
  const last4 = ident.account_number_last4 || ident.card_last4;
  return (
    <div className="tree-item">
      <div className="item-icon">{icon}</div>
      <div className="item-details">
        <div className="item-name">{acc.account_name}</div>
        <div className="item-meta">
          {ident.institution_name} {last4 ? `• ····${last4}` : ''}
        </div>
      </div>
    </div>
  );
};

export default Profile;
