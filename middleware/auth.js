const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET env var not set, using insecure fallback');
}

module.exports = {
  sign(user) {
    return jwt.sign(
      { id: user.id, role: user.role_enum, branch_id: user.branch_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
  },

  requireAuth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: 'Unauthorized' });
    }
  }
};
