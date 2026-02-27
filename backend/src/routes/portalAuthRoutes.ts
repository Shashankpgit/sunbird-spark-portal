import express, { Request, Response } from 'express';
import { keycloak } from '../auth/keycloakProvider.js';
import logger from '../utils/logger.js';
import { regenerateSession, regenerateAnonymousSession } from '../utils/sessionUtils.js';
import { setSessionTTLFromToken } from '../utils/sessionTTLUtil.js';
import { fetchUserById, setUserSession } from '../services/userService.js';
import { envConfig } from '../config/env.js';
import { sessionMiddleware } from '../middlewares/conditionalSession.js';
import _ from 'lodash';

const router = express.Router();

router.get('/login',
    sessionMiddleware,
    (req: Request, res: Response) => {
        // If already authenticated, go home
        if (req.session && _.get(req, 'kauth.grant')) {
            logger.info('User already authenticated, redirecting to home');
            return res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL + '/home');
        }

        // Redirect directly to the Keycloak OIDC authorization endpoint
        const callbackUrl = encodeURIComponent(envConfig.SERVER_URL + '/portal/auth/callback');
        const oidcAuthUrl = `${envConfig.DOMAIN_URL}/auth/realms/${envConfig.PORTAL_REALM}/protocol/openid-connect/auth` +
            `?client_id=${encodeURIComponent(envConfig.PORTAL_AUTH_SERVER_CLIENT)}` +
            `&redirect_uri=${callbackUrl}` +
            `&response_type=code` +
            `&scope=openid`;

        logger.info('Redirecting to OIDC authorization endpoint');
        res.redirect(oidcAuthUrl);
    }
);

router.get('/auth/callback',
    sessionMiddleware,
    // keycloak.middleware provides: req.kauth init (setup.js) and session grant reading (grant-attacher.js)
    keycloak.middleware({ admin: '/home', logout: '/portal/logout' }),
    async (req: Request, res: Response) => {
        if (!req.session) {
            logger.error('No session found at callback');
            return res.redirect('/');
        }

        // Already authenticated — grant was loaded from the session by grant-attacher
        if (_.get(req, 'kauth.grant')) {
            logger.info('Grant already present, redirecting to home');
            return res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL + '/home');
        }

        const code = req.query.code as string | undefined;
        if (!code) {
            logger.warn('No authorization code at callback, redirecting to login');
            return res.redirect('/portal/login');
        }

        try {
            // Set the redirect_uri that was used in the OIDC authorization request
            // so keycloak-connect's token exchange uses the correct value
            req.session.auth_redirect_uri = envConfig.SERVER_URL + '/portal/auth/callback';

            const grant = await keycloak.getGrantFromCode(code, req, res);
            req.kauth = { grant };

            await regenerateSession(req);
            setSessionTTLFromToken(req);

            const tokenSubject = _.get(req, 'kauth.grant.access_token.content.sub');
            if (tokenSubject) {
                const userIdFromToken = _.last(_.split(tokenSubject, ':'));
                req.session.userId = userIdFromToken;

                if (userIdFromToken) {
                    const userProfileResponse = await fetchUserById(userIdFromToken, req);
                    await setUserSession(req, userProfileResponse);
                }
            }

            logger.info('Session setup complete, redirecting to /home');
            res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL + '/home');
        } catch (err) {
            logger.error('Error during token exchange', err);
            res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL || '/');
        }
    }
);

router.all('/logout', sessionMiddleware, async (req: Request, res: Response) => {
    try {
        await regenerateAnonymousSession(req);
        const logoutUrl = `${envConfig.DOMAIN_URL}/auth/realms/${envConfig.PORTAL_REALM}/protocol/openid-connect/logout?redirect_uri=${encodeURIComponent(envConfig.DEVELOPMENT_REACT_APP_URL || envConfig.SERVER_URL + '/')}`;
        res.redirect(logoutUrl);
    } catch (err) {
        logger.error('Error regenerating session on logout', err);
        res.redirect('/');
    }
});

export default router;
