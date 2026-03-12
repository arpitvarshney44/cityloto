const User = require('../models/User');

module.exports = async function (req, res, next) {
    try {
        const user = await User.findById(req.user.id).select('isAdmin');
        if (!user || !user.isAdmin) {
            return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
        }
        next();
    } catch (err) {
        console.error('Admin middleware error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};
