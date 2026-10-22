import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { authApi, type User } from "@/services/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, adminCode?: string, expectedRole?: User["role"]) => Promise<User>;
  register: (payload: {
    email: string;
    password: string;
    displayName: string;
    fullName: string;
    role: "EMPLOYEE";
    department?: string;
    position?: string;
    employeeId?: string;
    phoneNumber?: string;
    address?: string;
  }) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const LOCAL_STORAGE_KEY = "estatehub_user";

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
      return cached ? (JSON.parse(cached) as User) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const syncUser = async () => {
      try {
        const response = await authApi.me();
        setUser(response.data.user);
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(response.data.user));
      } catch {
        setUser(null);
        localStorage.removeItem(LOCAL_STORAGE_KEY);
      } finally {
        setLoading(false);
      }
    };

    syncUser();
  }, []);

  const login = async (email: string, password: string, adminCode?: string, expectedRole?: User["role"]) => {
    const response = await authApi.login(email, password, adminCode, expectedRole);
    setUser(response.data.user);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(response.data.user));
    return response.data.user;
  };

  const register = async (payload: AuthContextValue["register"] extends (arg: infer P) => Promise<User> ? P : never) => {
    const response = await authApi.register(payload);
    setUser(response.data.user);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(response.data.user));
    return response.data.user;
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  };

  const value = useMemo(() => ({ user, loading, login, register, logout }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
};
