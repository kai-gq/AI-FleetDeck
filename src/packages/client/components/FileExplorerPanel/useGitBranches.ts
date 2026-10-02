/**
 * useGitBranches - Custom hook for git branch management
 *
 * Handles loading branches, checkout, create, pull, and push operations.
 * Following useGitStatus.ts patterns.
 */

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitBranch, GitBranchOperationResult, MergeResult, UseGitBranchesReturn } from './types';
import { apiUrl, authFetch } from '../../utils/storage';

export function useGitBranches(): UseGitBranchesReturn {
  const { t } = useTranslation(['terminal']);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationInProgress, setOperationInProgress] = useState<string | null>(null);

  const loadBranches = useCallback(async (directory: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/files/git-branches?path=${encodeURIComponent(directory)}`)
      );
      const data = await res.json();
      if (res.ok) {
        setBranches(data.branches || []);
      } else {
        setError(data.error || t('terminal:fileExplorer.loadBranchesFailed', { defaultValue: 'Failed to load branches' }));
        setBranches([]);
      }
    } catch (err) {
      console.error('[GitBranches] Failed to load branches:', err);
      setError(t('terminal:fileExplorer.loadBranchesFailed', { defaultValue: 'Failed to load branches' }));
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const checkoutBranch = useCallback(async (directory: string, branch: string): Promise<GitBranchOperationResult> => {
    setOperationInProgress('checkout');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, branch }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('terminal:fileExplorer.checkoutFailed', { defaultValue: 'Checkout failed' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Checkout failed:', err);
      const result = { success: false, error: t('terminal:fileExplorer.checkoutFailed', { defaultValue: 'Checkout failed' }) };
      setError(result.error);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  const createBranch = useCallback(async (directory: string, name: string, startPoint?: string): Promise<GitBranchOperationResult> => {
    setOperationInProgress('create');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-branch-create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, name, startPoint }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('terminal:fileExplorer.createBranchFailed', { defaultValue: 'Failed to create branch' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Create branch failed:', err);
      const result = { success: false, error: t('terminal:fileExplorer.createBranchFailed', { defaultValue: 'Failed to create branch' }) };
      setError(result.error);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  const pullFromRemote = useCallback(async (directory: string): Promise<MergeResult> => {
    setOperationInProgress('pull');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-pull'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory }),
      });
      const data = await res.json();
      if (!res.ok && !data.conflicts) {
        setError(data.error || t('terminal:fileExplorer.pullFailed', { defaultValue: 'Pull failed' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Pull failed:', err);
      const result: MergeResult = { success: false, error: t('terminal:fileExplorer.pullFailed', { defaultValue: 'Pull failed' }) };
      setError(result.error!);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  const pushToRemote = useCallback(async (directory: string): Promise<GitBranchOperationResult> => {
    setOperationInProgress('push');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-push'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('terminal:fileExplorer.pushFailed', { defaultValue: 'Push failed' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Push failed:', err);
      const result = { success: false, error: t('terminal:fileExplorer.pushFailed', { defaultValue: 'Push failed' }) };
      setError(result.error);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  const mergeBranch = useCallback(async (directory: string, branch: string): Promise<MergeResult> => {
    setOperationInProgress('merge');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-merge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, branch }),
      });
      const data = await res.json();
      if (!res.ok && !data.conflicts) {
        setError(data.error || t('terminal:fileExplorer.toast.mergeFailedMsg', { defaultValue: 'Merge failed' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Merge failed:', err);
      const result: MergeResult = { success: false, error: t('terminal:fileExplorer.toast.mergeFailedMsg', { defaultValue: 'Merge failed' }) };
      setError(result.error!);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  const mergeAbort = useCallback(async (directory: string): Promise<GitBranchOperationResult> => {
    setOperationInProgress('merge-abort');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-merge-abort'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('terminal:fileExplorer.mergeAbortFailed', { defaultValue: 'Merge abort failed' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Merge abort failed:', err);
      const result = { success: false, error: t('terminal:fileExplorer.mergeAbortFailed', { defaultValue: 'Merge abort failed' }) };
      setError(result.error);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  const mergeContinue = useCallback(async (directory: string): Promise<GitBranchOperationResult> => {
    setOperationInProgress('merge-continue');
    setError(null);
    try {
      const res = await authFetch(apiUrl('/api/files/git-merge-continue'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('terminal:fileExplorer.toast.mergeContinueFailed', { defaultValue: 'Merge continue failed' }));
      }
      return data;
    } catch (err) {
      console.error('[GitBranches] Merge continue failed:', err);
      const result = { success: false, error: t('terminal:fileExplorer.toast.mergeContinueFailed', { defaultValue: 'Merge continue failed' }) };
      setError(result.error);
      return result;
    } finally {
      setOperationInProgress(null);
    }
  }, [t]);

  return {
    branches,
    loading,
    error,
    operationInProgress,
    loadBranches,
    checkoutBranch,
    createBranch,
    pullFromRemote,
    pushToRemote,
    mergeBranch,
    mergeAbort,
    mergeContinue,
  };
}
