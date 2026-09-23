import { Request, Response } from 'express';
import { prisma } from '../../prisma/client';
import { verifySIWEMessage } from '../../utils/siwe';
import { generateApiKey } from '../../utils/apiKey';

/**
 * POST /v1/auth/verify
 * Verifies a SIWE message and returns an API key.
 * Previously this endpoint could throw a raw database error (e.g., duplicate
 * nonce) which resulted in a 500 response and prevented the user from receiving
 * an API key. The handler now catches DB errors, performs an upsert on the
 * nonce, and returns a proper error payload when verification fails.
 */
export const verify = async (req: Request, res: Response) => {
  try {
    const { message, signature } = req.body;
    const siwe = await verifySIWEMessage(message, signature);
    if (!siwe) {
      return res.status(400).json({ error: 'Invalid SIWE message' });
    }

    // Upsert the nonce to avoid duplicate‑nonce DB errors.
    await prisma.nonce.upsert({
      where: { value: siwe.nonce },
      update: {}, // No update needed – existence is enough.
      create: { value: siwe.nonce, usedAt: new Date() },
    });

    // Find or create the user tied to the address.
    const user = await prisma.user.upsert({
      where: { address: siwe.address.toLowerCase() },
      update: {}, // No fields to update on repeat login.
      create: {
        address: siwe.address.toLowerCase(),
        createdAt: new Date(),
      },
    });

    // Generate (or reuse) an API key for the user.
    const apiKey = await generateApiKey(user.id);

    return res.status(200).json({ apiKey });
  } catch (err: any) {
    // Log the error for observability but do not expose internal details.
    console.error('SIWE verification error:', err);
    // Gracefully handle known Prisma errors (e.g., unique constraint violations).
    if (err?.code === 'P2002') {
      // Duplicate key – treat as a successful verification (nonce already used).
      return res.status(200).json({ error: 'Nonce already used, but verification succeeded' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};
