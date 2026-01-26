import { initDatabase, isOGPeriodActive } from './lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await initDatabase();

    const ogActive = isOGPeriodActive();
    const launchDate = process.env.YELLOW_WORLD_LAUNCH_DATE;

    return res.status(200).json({
      success: true,
      message: 'Database initialized successfully',
      ogPeriod: {
        active: ogActive,
        launchDate: launchDate || 'Not configured - set YELLOW_WORLD_LAUNCH_DATE env var'
      },
      tables: ['users', 'badges', 'user_badges'],
      defaultBadges: 10
    });

  } catch (error) {
    console.error('Database init error:', error);
    return res.status(500).json({ 
      error: 'Database initialization failed',
      details: error.message
    });
  }
}