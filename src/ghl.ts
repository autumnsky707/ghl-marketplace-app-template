import qs from "qs";
import axios, { InternalAxiosRequestConfig } from "axios";
import { createDecipheriv, createHash } from "node:crypto";

import {
  getInstallation,
  getAccessToken,
  getRefreshToken,
  updateTokens,
  upsertInstallation,
  isTokenExpired,
} from "./db";
import { GHLTokenResponse } from "./types";

// In-memory map to deduplicate concurrent refresh calls per resource
const refreshPromises = new Map<string, Promise<void>>();

export class GHL {
  /**
   * Exchange authorization code for tokens and persist to Supabase.
   * Returns the token response so the caller can use locationId, etc.
   */
  async authorizationHandler(code: string): Promise<GHLTokenResponse> {
    if (!code) {
      throw new Error("Please provide code when calling authorizationHandler");
    }
    return this.generateAccessTokenRefreshTokenPair(code);
  }

  decryptSSOData(key: string) {
    try {
      const blockSize = 16;
      const keySize = 32;
      const ivSize = 16;
      const saltSize = 8;

      const rawEncryptedData = Buffer.from(key, "base64");
      const salt = rawEncryptedData.subarray(saltSize, blockSize);
      const cipherText = rawEncryptedData.subarray(blockSize);

      let result = Buffer.alloc(0, 0);
      while (result.length < keySize + ivSize) {
        const hasher = createHash("md5");
        result = Buffer.concat([
          result,
          hasher
            .update(
              Buffer.concat([
                result.subarray(-ivSize),
                Buffer.from(process.env.GHL_APP_SSO_KEY as string, "utf-8"),
                salt,
              ])
            )
            .digest(),
        ]);
      }

      const decipher = createDecipheriv(
        "aes-256-cbc",
        result.subarray(0, keySize),
        result.subarray(keySize, keySize + ivSize)
      );

      const decrypted = decipher.update(cipherText);
      const finalDecrypted = Buffer.concat([decrypted, decipher.final()]);
      return JSON.parse(finalDecrypted.toString());
    } catch (error) {
      console.error("Error decrypting SSO data:", error);
      throw error;
    }
  }

  /**
   * Create an Axios instance with auth headers and 401 retry for a given resource.
   * Proactively refreshes expired tokens before attaching the header.
   */
  async requests(resourceId: string) {
    const baseUrl = process.env.GHL_API_DOMAIN;

    // Proactive refresh: check if token is expired before making the request
    const installation = await getInstallation(resourceId);
    if (!installation) {
      throw new Error(`Installation not found for resource: ${resourceId}`);
    }

    if (isTokenExpired(installation.token_expires_at)) {
      console.log(`[GHL] Token expired for ${resourceId}, refreshing proactively...`);
      await this.refreshAccessToken(resourceId);
    }

    const axiosInstance = axios.create({ baseURL: baseUrl });

    // Request interceptor: attach current access token
    axiosInstance.interceptors.request.use(
      async (requestConfig: InternalAxiosRequestConfig) => {
        const token = await getAccessToken(resourceId);
        requestConfig.headers["Authorization"] = `Bearer ${token}`;
        return requestConfig;
      }
    );

    // Response interceptor: retry once on 401 (fixed: uses axiosInstance, not global axios)
    axiosInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;
          await this.refreshAccessToken(resourceId);
          const newToken = await getAccessToken(resourceId);
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return axiosInstance(originalRequest);
        }
        return Promise.reject(error);
      }
    );

    return axiosInstance;
  }

  /**
   * Check if an installation exists in Supabase.
   */
  async checkInstallationExists(resourceId: string): Promise<boolean> {
    const token = await getAccessToken(resourceId);
    return !!token;
  }

  /**
   * Get a location-scoped token from a company-scoped token.
   */
  async getLocationTokenFromCompanyToken(companyId: string, locationId: string) {
    const client = await this.requests(companyId);
    const res = await client.post(
      "/oauth/locationToken",
      { companyId, locationId },
      { headers: { Version: "2021-07-28" } }
    );
    await upsertInstallation(res.data);
  }

  /**
   * Refresh access token with deduplication (prevents concurrent refreshes for same resource).
   */
  private async refreshAccessToken(resourceId: string): Promise<void> {
    // Deduplicate: if a refresh is already in progress for this resource, wait for it
    const existing = refreshPromises.get(resourceId);
    if (existing) {
      return existing;
    }

    const promise = this._doRefresh(resourceId);
    refreshPromises.set(resourceId, promise);

    try {
      await promise;
    } finally {
      refreshPromises.delete(resourceId);
    }
  }

  private async _doRefresh(resourceId: string): Promise<void> {
    try {
      const refreshToken = await getRefreshToken(resourceId);
      if (!refreshToken) {
        throw new Error(`No refresh token found for ${resourceId}`);
      }

      const resp = await axios.post(
        `${process.env.GHL_API_DOMAIN}/oauth/token`,
        qs.stringify({
          client_id: process.env.GHL_APP_CLIENT_ID,
          client_secret: process.env.GHL_APP_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        { headers: { "content-type": "application/x-www-form-urlencoded" } }
      );

      await updateTokens(
        resourceId,
        resp.data.access_token,
        resp.data.refresh_token,
        resp.data.expires_in
      );

      console.log(`[GHL] Token refreshed for ${resourceId}`);
    } catch (error: any) {
      console.error("[GHL] Token refresh failed:", error?.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Exchange authorization code for tokens and save to Supabase.
   * Includes user_type=Location as required by GHL OAuth.
   */
  private async generateAccessTokenRefreshTokenPair(code: string): Promise<GHLTokenResponse> {
    console.log("[GHL] Exchanging authorization code for tokens...");

    const resp = await axios.post(
      `${process.env.GHL_API_DOMAIN}/oauth/token`,
      qs.stringify({
        client_id: process.env.GHL_APP_CLIENT_ID,
        client_secret: process.env.GHL_APP_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        user_type: "Location",
      }),
      { headers: { "content-type": "application/x-www-form-urlencoded" } }
    );

    console.log("[GHL] Token exchange successful, locationId:", resp.data.locationId);

    const tokenData: GHLTokenResponse = resp.data;
    await upsertInstallation(tokenData);
    return tokenData;
  }
}
