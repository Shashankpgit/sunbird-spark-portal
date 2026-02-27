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

const postLoginMiddelware = (req: Request, res: Response, next: express.NextFunction) => {
    if (req.session && _.get(req, 'kauth.grant')) {
        logger.info('User already authenticated, redirecting to home');
        return res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL + '/home');
    }
    next();
};
/**
 * LOGIN
 * Starts OIDC flow OR handles post-auth redirect
 */
router.get(
  '/login',
  postLoginMiddelware,
  sessionMiddleware,
  keycloak.middleware({ admin: '/home', logout: '/portal/logout' }),
  keycloak.protect(),
  async (req: Request, res: Response) => {
    logger.info('Entered /portal/login post-auth handler');

    if (!req.session) {
      logger.error('No session after Keycloak auth');
      return res.redirect('/');
    }

    try {
      // Important: regenerate AFTER grant exists
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

      logger.info('Session setup complete, redirecting to home');
      return res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL + '/home');

    } catch (err) {
      logger.error('Error generating session on login', err);
      return res.redirect(envConfig.DEVELOPMENT_REACT_APP_URL || '/');
    }
  }
);

/**
 * LOGOUT
 */
router.all('/logout', sessionMiddleware, async (req: Request, res: Response) => {
  try {
    await regenerateAnonymousSession(req);

    const logoutUrl =
      `${envConfig.DOMAIN_URL}/auth/realms/${envConfig.PORTAL_REALM}/protocol/openid-connect/logout` +
      `?redirect_uri=${encodeURIComponent(
        envConfig.DEVELOPMENT_REACT_APP_URL || envConfig.SERVER_URL + '/'
      )}`;

    res.redirect(logoutUrl);

  } catch (err) {
    logger.error('Error regenerating session on logout', err);
    res.redirect('/');
  }
});

export default router;