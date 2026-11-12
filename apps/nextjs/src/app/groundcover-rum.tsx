'use client';

import groundcover from "@groundcover/browser";
import { useEffect } from "react";

export function GroundcoverRum() {
  useEffect(() => {
    console.log('Next.js - Initializing Groundcover SDK');
    console.log('Document ready state:', document.readyState);
    console.log('Window loaded:', document.readyState === 'complete');
    
    // Example: Generate or retrieve a shared sessionId for micro-frontend synchronization
    const sharedSessionId = sessionStorage.getItem('shared-session-id') || 
                           `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Store the sessionId for other micro-frontends to use
    sessionStorage.setItem('shared-session-id', sharedSessionId);
    
    groundcover.init({
      apiKey: process.env.NEXT_PUBLIC_GROUNDCOVER_API_KEY || "your-api-key",
      cluster: process.env.NEXT_PUBLIC_GROUNDCOVER_CLUSTER || "your-cluster",
      environment: process.env.NODE_ENV || "development",
      dsn: process.env.NEXT_PUBLIC_GROUNDCOVER_DSN || "your-dsn",
      appId: "nextjs-main-app",
      sessionId: sharedSessionId, // Use shared sessionId for micro-frontend sync
      options: {
        debug: true,
      },
    });
    
    console.log('Next.js - Groundcover SDK initialized with sessionId:', sharedSessionId);

    // Demo: explicit structured log via the SDK's logger API
    groundcover.logger.info('Next.js SDK boot', {
      appId: 'nextjs-demo',
      framework: 'next',
    });

    // Demo: structured console.log — object keys are auto-promoted
    // to queryable log attributes (in addition to being stringified into message)
    console.log('Next.js page hydrated', { route: '/', env: process.env.NODE_ENV });
  }, []);
  
  return null;
}
