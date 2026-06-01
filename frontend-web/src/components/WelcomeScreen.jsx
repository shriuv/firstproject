import React, { useState, useEffect } from 'react';
import { supabase } from '../shared/supabase';
import { useUser } from '../context/UserContext';
import '../styles/WelcomeScreen.css';

const WelcomeScreen = ({ toggleTheme, isDarkMode, onSetupComplete }) => {
  const user = useUser();
  const [userFullName, setUserFullName] = useState('User');
  const [profileType, setProfileType] = useState('INDIVIDUAL'); // INDIVIDUAL or BUSINESS
  const [modules, setModules] = useState([]);
  const [selectedModuleId, setSelectedModuleId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        setLoading(true);

        if (user) {
          if (user.user_metadata?.full_name) {
            const firstName = user.user_metadata.full_name.split(' ')[0];
            setUserFullName(firstName);
          }

          // Fetch pre-assigned modules just to establish setup
          const { data: assigned } = await supabase
            .from('user_modules')
            .select('module_id')
            .eq('user_id', user.id);

          if (assigned && assigned.length > 0) {
            setSelectedModuleId(assigned[0].module_id);
          }
        }
      } catch (err) {
        console.error('Error fetching user data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchInitialData();
  }, []);

  useEffect(() => {
    const fetchModules = async () => {
      try {
        const { data, error } = await supabase
          .from('coa_modules')
          .select('*')
          .eq('category', profileType)
          .eq('is_core', false); // Exclude core template module

        if (error) throw error;
        setModules(data || []);
      } catch (err) {
        console.error('Error fetching modules:', err);
      }
    };

    fetchModules();
  }, [profileType]);

  const handleModuleSelect = (moduleId) => {
    setSelectedModuleId(moduleId);
  };

  const handleContinueSetup = async () => {
    if (!selectedModuleId) return;

    try {
      setLoading(true);
      if (!user) throw new Error("User session expired");

      // 1. Get the Core Module ID
      const { data: coreModule } = await supabase
        .from('coa_modules')
        .select('module_id')
        .eq('module_name', 'Core')
        .single();

      const idsToFetch = [selectedModuleId];
      if (coreModule && coreModule.module_id !== selectedModuleId) {
        idsToFetch.push(coreModule.module_id);
      }

      // 2. Fetch Templates
      const { data: templates, error: fetchError } = await supabase
        .from('coa_templates')
        .select('*')
        .in('module_id', idsToFetch);

      if (fetchError) throw fetchError;

      // 3. Insert all accounts first without parent relationships
      const accountInserts = templates.map(t => ({
        user_id: user.id,
        account_name: t.account_name,
        account_type: t.account_type,
        balance_nature: t.balance_nature,
        is_system_generated: t.is_system_generated,
        template_id: t.template_id,
        include_in_llm: t.include_in_llm ?? true, // Inherit from template
        parent_account_id: null // Will be set in next step
      }));

      const { data: insertedAccounts, error: insertError } = await supabase
        .from('accounts')
        .insert(accountInserts)
        .select('account_id, template_id');

      if (insertError) throw insertError;

      // 4. Build a map of template_id -> account_id
      const templateMap = {};
      insertedAccounts.forEach(acc => {
        if (acc.template_id) {
          templateMap[acc.template_id] = acc.account_id;
        }
      });

      // 5. Update parent_account_id — fire ALL concurrently via Promise.all
      //    instead of serially (50+ sequential Supabase calls → 5-10s wait).
      const updates = templates
        .filter(t => t.parent_template_id && templateMap[t.parent_template_id])
        .map(t => ({
          account_id: templateMap[t.template_id],
          parent_account_id: templateMap[t.parent_template_id]
        }));

      await Promise.all(
        updates.map(update =>
          supabase
            .from('accounts')
            .update({ parent_account_id: update.parent_account_id })
            .eq('account_id', update.account_id)
        )
      );

      // 6. Insert into user_modules to mark setup completion
      const moduleInserts = idsToFetch.map(id => ({
        user_id: user.id,
        module_id: id
      }));

      const { error: userModuleError } = await supabase
        .from('user_modules')
        .insert(moduleInserts);

      if (userModuleError) throw userModuleError;

      if (onSetupComplete) onSetupComplete();


    } catch (err) {
      console.error('Setup failed:', err);
      alert('Setup failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="welcome-container loading">
        <span className="spinner"></span>
      </div>
    );
  }

  return (
    <div className="welcome-container">
      <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle Theme">
        {isDarkMode ? '☀️' : '🌙'}
      </button>
      <div className="welcome-content">
        <div className="welcome-header">
          <h1>Welcome, <span className="name-highlight">{userFullName}!</span></h1>
          <p className="description">Help us kickstart your profile by telling us a bit about who you are.</p>
        </div>

        {/* Section 1: Category Selector */}
        <div className="setup-section">
          <label className="section-label">1. What type of profile are you setting up?</label>
          <div className="category-toggle-grid">
            <button
              className={`category-btn ${profileType === 'INDIVIDUAL' ? 'selected' : ''}`}
              onClick={() => { setProfileType('INDIVIDUAL'); setSelectedModuleId(null); }}
            >
              <div className="category-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
              </div>
              <span>Individual</span>
            </button>
            <button
              className={`category-btn ${profileType === 'BUSINESS' ? 'selected' : ''}`}
              onClick={() => { setProfileType('BUSINESS'); setSelectedModuleId(null); }}
            >
              <div className="category-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
              </div>
              <span>Business</span>
            </button>
          </div>
        </div>

        {/* Section 2: Module Selector */}
        <div className="setup-section">
          <label className="section-label">2. Select the specific setup:</label>
          <div className="modules-grid">
            {modules.map((module) => (
              <button
                key={module.module_id}
                className={`module-card ${selectedModuleId === module.module_id ? 'selected' : ''}`}
                onClick={() => handleModuleSelect(module.module_id)}
              >
                <h3>{module.module_name}</h3>
                <p>{module.description}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="footer-actions">
          <button
            className="continue-btn"
            disabled={!selectedModuleId}
            onClick={handleContinueSetup}
          >
            Continue Setup
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;
