import express from 'express';
import cors from 'cors';
import { oidcSession } from './auth/oidcMiddleware.js';
import formRoutes from './routes/formsRoutes.js';
import googleRoutes from './routes/googleRoutes.js';
import portalAuthRoutes from './routes/portalAuthRoutes.js';
import portalProxyRoutes from './routes/portalProxyRoutes.js';
import editorRoutes from './routes/editorRoutes.js';
import { redirectTenant } from './controllers/tenantController.js';
import { loadTenants } from './services/tenantService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { checkHealth } from './controllers/healthController.js';
import helmet from 'helmet';
import authRoutes from './routes/userAuthInfoRoutes.js';
import { getAppInfo } from './controllers/appInfoController.js';
import { sessionMiddleware, anonymousMiddlewares } from './middlewares/conditionalSession.js';
import { envConfig } from './config/env.js';
import portalAnonymousProxyRoutes from './routes/portalAnonymousProxyRoutes.js';
import knowlgMwProxyRoutes from './routes/knowlgMwProxyRoutes.js';
import anonymousActionRoutes from './routes/anonymousActionRoutes.js';
import mobileRoutes from './routes/mobileRoutes.js';
import { buildInfo } from './services/buildInfo.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));

loadTenants();
app.use(cors());
// Override body limit for telemetry BEFORE the global 100KB default parser.
// The SDK can flush large batches; 10mb gives ample headroom above the ~40KB typical max.
app.use('/action/data/v3/telemetry', express.json({ limit: '10mb' }));
app.use(express.json());
app.use(express.urlencoded());
app.get('/health', checkHealth);
app.get('/portal/app/v1/info', getAppInfo);


// Mobile API Routes (stateless — returns tokens directly, no session)
app.use('/mobile', mobileRoutes);

// Portal Authentication Routes (Login, Callback, Logout) — registered first to bypass anonymous middleware
app.use('/portal', portalAuthRoutes);
// Portal Anonymous Routes
app.use('/portal', sessionMiddleware, ...anonymousMiddlewares, portalAnonymousProxyRoutes)

// Apply anonymous session middleware to API routes (once per route tree)

app.use('/data/v1/form', formRoutes);
app.use('/portal/user/v1/auth', sessionMiddleware, ...anonymousMiddlewares, oidcSession(), authRoutes);
app.use('/google', googleRoutes);

// Intercept preview.html to substitute the BUILD_NUMBER placeholder with the
// actual build hash. The ECML renderer uses this value for cache-busting plugin
// asset URLs — without substitution, the literal string "BUILD_NUMBER" appears
// in every asset URL instead of the real hash.
app.get('/content/preview/preview.html', async (_req, res) => {
    const previewPath = path.join(__dirname, 'public', 'content', 'preview', 'preview.html');
    try {
        const html = await fs.readFile(previewPath, 'utf8');
        const patched = html.replace(/BUILD_NUMBER/g, buildInfo.buildHash);
        res.setHeader('Content-Type', 'text/html');
        res.send(patched);
    } catch {
        res.status(404).send('Not found');
    }
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Anonymous-safe /action/* routes — registered BEFORE editorRoutes so that
// POST /action/data/v3/telemetry is NOT intercepted by editorRoutes' requireAuth().
app.use('/action', sessionMiddleware, ...anonymousMiddlewares, anonymousActionRoutes);

// Specific /action endpoints (editor, review comments) — require authentication.
app.use("/action", editorRoutes);

// All remaining /action/* routes proxy to knowledge-mw-service.
// oidcSession() deserializes the OIDC tokens from the session so that
// decorateRequestHeaders can read the user's access token for upstream auth.
app.use('/', sessionMiddleware, ...anonymousMiddlewares, oidcSession(), knowlgMwProxyRoutes);

// Portal Proxy Routes (authenticated — oidcSession populates req.oidc for requireAuth)
app.use('/portal', oidcSession(), portalProxyRoutes);

app.get('/:tenantName', redirectTenant);

app.get(/.*/, sessionMiddleware, ...anonymousMiddlewares, (req, res) => {
    const isLocal = envConfig.ENVIRONMENT == 'local'
    if (isLocal) {
        return res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL || '/');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
