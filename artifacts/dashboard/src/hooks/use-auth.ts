import { useState, useEffect } from 'react';
import { useGetMe, getGetMeQueryKey } from '@workspace/api-client-react';
import { getToken, removeToken } from '../lib/auth';
import { useLocation } from 'wouter';

export function useAuth() {
  const [location, setLocation] = useLocation();
  const token = getToken();
  
  const { data: user, error, isLoading } = useGetMe({ 
    query: { 
      enabled: !!token,
      retry: false,
      queryKey: getGetMeQueryKey()
    } 
  });

  useEffect(() => {
    if (error) {
      removeToken();
      if (location !== '/login') {
        setLocation('/login');
      }
    }
  }, [error, location, setLocation]);

  return {
    user,
    isLoading: isLoading && !!token,
    isAuthenticated: !!user,
  };
}
