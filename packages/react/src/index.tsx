import React, { createContext, useContext, useEffect, useState, useMemo } from "react";
import type { ZerithDBConfig } from "zerithdb-sdk";
import type { SharedWorkerApp } from "./shared-worker-protocol.js";
import { createSharedWorkerApp } from "./shared-worker-app.js";
import type { QueryFilter } from "./shared-worker-protocol.js";

const ZerithContext = createContext<SharedWorkerApp | null>(null);

export interface ZerithProviderProps {
  config: ZerithDBConfig;
  children: React.ReactNode;
}

/**
 * Global provider for ZerithDB.
 * Initializes the P2P client and makes it available via hooks.
 */
export const ZerithProvider: React.FC<ZerithProviderProps> = ({ config, children }) => {
  const client = useMemo(() => createSharedWorkerApp(config), [JSON.stringify(config)]);

  return <ZerithContext.Provider value={client}>{children}</ZerithContext.Provider>;
};

/**
 * Access the underlying ZerithDB app client directly.
 */
export const useZerith = (): SharedWorkerApp => {
  const context = useContext(ZerithContext);
  if (!context) {
    throw new Error("useZerith must be used within a ZerithProvider");
  }
  return context;
};

// Helper hook to deep-compare the filter to avoid unnecessary re-subscriptions
function useDeepCompareMemoize<T>(value: T) {
  const ref = React.useRef<T>(value);
  if (JSON.stringify(value) !== JSON.stringify(ref.current)) {
    ref.current = value;
  }
  return ref.current;
}

/**
 * Reactive hook to query a collection.
 * Automatically updates when local or remote (P2P) changes occur.
 * @param collectionName The name of the collection to query
 * @param filter A MongoDB-style query filter. Must be JSON-serializable.
 */
export function useQuery<T extends Record<string, any>>(collectionName: string, filter: QueryFilter<T> = {}) {
  const app = useZerith();
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const memoizedFilter = useDeepCompareMemoize(filter);

  useEffect(() => {
    let mounted = true;

    const collection = app.db<T>(collectionName);

    // Subscribe to real-time updates (SharedWorker broadcasts updates to all tabs).
    // When a mutation fires, re-fetch with the server-side filter for accurate results.
    const unsubscribe = collection.subscribe(() => {
      if (!mounted) return;
      void collection.find(memoizedFilter).then((docs) => {
        if (mounted) {
          setData(docs as T[]);
          setLoading(false);
        }
      }).catch((err: Error) => {
        if (mounted) {
          setError(err);
          setLoading(false);
        }
      });
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [app, collectionName, memoizedFilter]);

  const insert = async (item: T) => {
    return app.db<T>(collectionName).insert(item);
  };

  const remove = async (id: string) => {
    return app.db<T>(collectionName).delete(id);
  };

  return { data, loading, error, insert, remove };
}

/**
 * Hook to access and manage P2P sync state
 */
export function useSync() {
  const app = useZerith();
  const [state, setState] = useState(() => app.sync.state);

  useEffect(() => {
    // SharedWorkerBridge updates syncState via worker messages; poll to reflect changes in React
    const interval = setInterval(() => setState(app.sync.state), 1000);
    return () => clearInterval(interval);
  }, [app]);

  return {
    state,
    enable: () => app.sync.enable(),
    disable: () => app.sync.disable(),
  };
}

/**
 * Hook to manage authentication and identity
 */
export function useAuth() {
  const app = useZerith();
  const [identity, setIdentity] = useState(() => app.auth.identity);

  useEffect(() => {
    setIdentity(app.auth.identity);
  }, [app]);

  const signIn = async () => {
    const id = await app.auth.signIn();
    setIdentity(id);
    return id;
  };

  const signOut = () => {
    app.auth.signOut();
    setIdentity(null);
  };

  return { identity, signIn, signOut };
}
