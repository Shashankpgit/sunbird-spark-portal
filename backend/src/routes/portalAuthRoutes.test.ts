import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mocks
const mockGetGrantFromCode = vi.fn();
const mockKeycloakMiddleware = vi.fn(() => (req: Request, res: Response, next: NextFunction) => next());

vi.mock('../auth/keycloakProvider.js', () => ({
    keycloak: {
        middleware: mockKeycloakMiddleware,
        getGrantFromCode: (...args: any[]) => mockGetGrantFromCode(...args),
    }
}));

vi.mock('../utils/logger.js', () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../utils/sessionUtils.js', () => ({
    regenerateSession: vi.fn(),
    regenerateAnonymousSession: vi.fn()
}));

vi.mock('../utils/sessionTTLUtil.js', () => ({
    setSessionTTLFromToken: vi.fn()
}));

vi.mock('../services/userService.js', () => ({
    fetchUserById: vi.fn(),
    setUserSession: vi.fn()
}));

vi.mock('../middlewares/conditionalSession.js', () => ({
    sessionMiddleware: (req: Request, res: Response, next: NextFunction) => {
        if (!req.session) {
            // @ts-ignore
            req.session = {};
        }
        next();
    }
}));

vi.mock('../config/env.js', () => ({
    envConfig: {
        DEVELOPMENT_REACT_APP_URL: 'http://localhost:3000',
        DOMAIN_URL: 'http://domain.com',
        PORTAL_REALM: 'realm',
        PORTAL_AUTH_SERVER_CLIENT: 'portal',
        SERVER_URL: 'http://server.com'
    }
}));

describe('PortalAuthRoutes Integration', () => {
    let app: express.Application;

    const setupApp = async (customMiddleware?: express.RequestHandler) => {
        vi.resetModules();
        const portalAuthRoutes = (await import('./portalAuthRoutes.js')).default;

        app = express();

        if (customMiddleware) {
            app.use(customMiddleware);
        } else {
            app.use((req, res, next) => {
                // @ts-ignore
                req.session = {};
                next();
            });
        }

        app.use('/portal', portalAuthRoutes);
        return app;
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('GET /portal/login', () => {
        it('should redirect to home if user is already authenticated', async () => {
            const app = await setupApp((req: Request, res, next) => {
                // @ts-ignore
                req.session = {};
                // @ts-ignore
                req.kauth = { grant: { access_token: 'token' } };
                next();
            });

            const res = await request(app).get('/portal/login');
            expect(res.status).toBe(302);
            expect(res.header.location).toBe('http://localhost:3000/home');
        });

        it('should redirect to OIDC authorization endpoint if not authenticated', async () => {
            const app = await setupApp();
            const res = await request(app).get('/portal/login');
            expect(res.status).toBe(302);

            const location = res.header.location as string;
            expect(location).toContain('http://domain.com/auth/realms/realm/protocol/openid-connect/auth');
            expect(location).toContain('client_id=portal');
            expect(location).toContain('redirect_uri=' + encodeURIComponent('http://server.com/portal/auth/callback'));
            expect(location).toContain('response_type=code');
            expect(location).toContain('scope=openid');
        });
    });

    describe('GET /portal/auth/callback', () => {
        it('should redirect to login if no code and no grant', async () => {
            const app = await setupApp();
            const res = await request(app).get('/portal/auth/callback');
            expect(res.status).toBe(302);
            expect(res.header.location).toBe('/portal/login');
        });

        it('should redirect to home if grant already exists in session', async () => {
            const app = await setupApp((req: Request, res, next) => {
                // @ts-ignore
                req.session = {};
                // @ts-ignore
                req.kauth = { grant: { access_token: 'existing-token' } };
                next();
            });

            const res = await request(app).get('/portal/auth/callback');
            expect(res.status).toBe(302);
            expect(res.header.location).toBe('http://localhost:3000/home');
        });

        it('should exchange code and redirect to home', async () => {
            const app = await setupApp();
            const sessionUtils = await import('../utils/sessionUtils.js');
            vi.mocked(sessionUtils.regenerateSession).mockResolvedValue(undefined);
            mockGetGrantFromCode.mockResolvedValue({ access_token: {} });

            const res = await request(app).get('/portal/auth/callback?code=abc123');

            expect(res.status).toBe(302);
            expect(res.header.location).toBe('http://localhost:3000/home');
            expect(mockGetGrantFromCode).toHaveBeenCalledWith('abc123', expect.anything(), expect.anything());
            expect(sessionUtils.regenerateSession).toHaveBeenCalled();
        });

        it('should fetch user profile when token has a subject', async () => {
            const app = await setupApp();
            const sessionUtils = await import('../utils/sessionUtils.js');
            const userService = await import('../services/userService.js');

            vi.mocked(sessionUtils.regenerateSession).mockResolvedValue(undefined);
            vi.mocked(userService.fetchUserById).mockResolvedValue({} as any);
            vi.mocked(userService.setUserSession).mockResolvedValue(undefined);
            mockGetGrantFromCode.mockResolvedValue({
                access_token: {
                    content: { sub: 'f:keycloak:user123' }
                }
            });

            await request(app).get('/portal/auth/callback?code=abc123');

            expect(userService.fetchUserById).toHaveBeenCalledWith('user123', expect.anything());
            expect(userService.setUserSession).toHaveBeenCalled();
        });

        it('should redirect to app root on token exchange error', async () => {
            const app = await setupApp();
            mockGetGrantFromCode.mockRejectedValue(new Error('Token exchange failed'));

            const res = await request(app).get('/portal/auth/callback?code=bad-code');

            expect(res.status).toBe(302);
            expect(res.header.location).toBe('http://localhost:3000');
        });

        it('should redirect to app root on session regeneration error', async () => {
            const app = await setupApp();
            const sessionUtils = await import('../utils/sessionUtils.js');
            mockGetGrantFromCode.mockResolvedValue({ access_token: {} });
            vi.mocked(sessionUtils.regenerateSession).mockRejectedValue(new Error('Session error'));

            const res = await request(app).get('/portal/auth/callback?code=abc123');

            expect(res.status).toBe(302);
            expect(res.header.location).toBe('http://localhost:3000');
        });

        it('should redirect to login when no session, no code, and no grant', async () => {
            // sessionMiddleware always ensures req.session exists; with no code the handler
            // falls through to the "no code" guard and redirects to login
            const app = await setupApp((req: Request, res, next) => {
                // @ts-ignore
                req.session = null;
                next();
            });

            const res = await request(app).get('/portal/auth/callback');
            expect(res.status).toBe(302);
            expect(res.header.location).toBe('/portal/login');
        });
    });

    describe('GET /portal/logout', () => {
        it('should regenerate anonymous session and redirect to Keycloak logout', async () => {
            const app = await setupApp();
            const sessionUtils = await import('../utils/sessionUtils.js');
            vi.mocked(sessionUtils.regenerateAnonymousSession).mockResolvedValue(undefined);

            const res = await request(app).get('/portal/logout');

            expect(sessionUtils.regenerateAnonymousSession).toHaveBeenCalled();
            expect(res.status).toBe(302);
            expect(res.header.location).toContain('/auth/realms/realm/protocol/openid-connect/logout');
        });

        it('should redirect to / on logout error', async () => {
            const app = await setupApp();
            const sessionUtils = await import('../utils/sessionUtils.js');
            vi.mocked(sessionUtils.regenerateAnonymousSession).mockRejectedValue(new Error('Logout error'));

            const res = await request(app).get('/portal/logout');

            expect(res.status).toBe(302);
            expect(res.header.location).toBe('/');
        });
    });
});
