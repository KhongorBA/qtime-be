/** Admin эрх шалгах - role === 'admin' */

export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin only' });
  }
  next();
};
