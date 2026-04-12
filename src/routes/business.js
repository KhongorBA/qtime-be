import express from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../config/db.js';
import { protect } from '../middleware/auth.js';
import { optionalAuth } from '../middleware/auth.js';
import { sendFcmMessage } from '../utils/firebaseAdmin.js';

export const businessRoutes = express.Router();

const defaultCategories = [
  { id: 'hair_salon', name: 'Hair salon', icon: 'content_cut' },
  { id: 'barber', name: 'Barber', icon: 'face' },
  { id: 'nail', name: 'Nail', icon: 'back_hand' },
  { id: 'massage', name: 'Massage', icon: 'spa' },
  { id: 'car_wash', name: 'Car wash', icon: 'local_car_wash' },
  { id: 'billiard', name: 'Billiard', icon: 'sports_bar' },
  { id: 'fitness', name: 'Fitness', icon: 'fitness_center' },
  { id: 'spa', name: 'Spa', icon: 'self_improvement' },
  { id: 'game_center', name: 'Game Center', icon: 'sports_esports' }
];

const categoryIconById = {
  hair_salon: 'content_cut',
  barber: 'face',
  nail: 'back_hand',
  massage: 'spa',
  car_wash: 'local_car_wash',
  billiard: 'sports_bar',
  fitness: 'fitness_center',
  spa: 'self_improvement',
  game_center: 'sports_esports',
};

const normalizeCategoryId = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const createBusinessCode = () => `BZ${Math.floor(100000 + Math.random() * 900000)}`;

/** Business.ownerId эсвэл баталгаажсан BusinessMember(owner) — өөр бизнест join хориглох */
const userIsApprovedBusinessOwner = async (userId) => {
  const [ownedCount, ownerMemberCount] = await Promise.all([
    prisma.business.count({ where: { ownerId: userId } }),
    prisma.businessMember.count({
      where: { userId, role: 'owner', status: 'approved' },
    }),
  ]);
  return ownedCount > 0 || ownerMemberCount > 0;
};

businessRoutes.get('/', optionalAuth, async (req, res) => {
  try {
    const { city, category, page = 1, limit = 20 } = req.query;
    const userId = req.user?.id || null;
    const where = { status: 'approved' };
    if (city) where.addressCity = { contains: city, mode: 'insensitive' };
    if (category) where.category = { contains: category, mode: 'insensitive' };

    const [businessesRaw, total] = await Promise.all([
      prisma.business.findMany({
        where,
        include: {
          owner: { select: { name: true } },
          ...(userId
            ? { favoritedBy: { where: { id: userId }, select: { id: true } } }
            : {}),
        },
        orderBy: { rating: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit)
      }),
      prisma.business.count({ where })
    ]);

    const businesses = businessesRaw.map((b) => ({
      ...b,
      isFavorite: Array.isArray(b.favoritedBy) && b.favoritedBy.length > 0,
      favoritedBy: undefined,
    }));

    res.json({ businesses, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

businessRoutes.get('/categories', async (req, res) => {
  try {
    const rows = await prisma.business.findMany({
      where: { status: 'approved' },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    const fromDb = rows
      .map((r) => String(r.category || '').trim())
      .filter((v) => v.length > 0)
      .map((name) => {
        const id = normalizeCategoryId(name);
        return {
          id,
          name,
          icon: categoryIconById[id] || 'storefront',
        };
      });
    if (fromDb.length > 0) {
      return res.json(fromDb);
    }
    return res.json(defaultCategories);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

businessRoutes.get('/search', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const query = String(req.query.q || '').trim();
    const code = String(req.query.code || '').trim().toUpperCase();
    if (!query && !code) {
      return res.status(400).json({ message: 'Зөвхөн approved бизнест хүсэлт илгээнэ' });
    }

    const where = {
      status: 'approved',
      ...(code
        ? { businessCode: code }
        : { name: { contains: query, mode: 'insensitive' } })
    };

    const businesses = await prisma.business.findMany({
      where,
      select: {
        id: true,
        name: true,
        category: true,
        rating: true,
        reviewCount: true,
        phone: true,
        images: true,
        latitude: true,
        longitude: true,
        addressStreet: true,
        addressCity: true,
        addressCountry: true,
        businessCode: true,
        status: true,
        ...(userId
          ? { favoritedBy: { where: { id: userId }, select: { id: true } } }
          : {}),
      },
      take: 30,
      orderBy: { rating: 'desc' }
    });

    let memberByBusinessId = new Map();
    if (userId && businesses.length > 0) {
      const ids = businesses.map((b) => b.id);
      const members = await prisma.businessMember.findMany({
        where: { userId, businessId: { in: ids } },
        select: { businessId: true, status: true, role: true },
      });
      memberByBusinessId = new Map(members.map((m) => [m.businessId, m]));
    }

    const mapped = businesses.map((b) => {
      const m = memberByBusinessId.get(b.id);
      return {
        ...b,
        isFavorite: Array.isArray(b.favoritedBy) && b.favoritedBy.length > 0,
        favoritedBy: undefined,
        ...(userId
          ? {
              myMembershipStatus: m?.status ?? null,
              myMembershipRole: m?.role ?? null,
            }
          : {}),
      };
    });
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

businessRoutes.get('/:id', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const business = await prisma.business.findUnique({
      where: { id: req.params.id },
      include: {
        owner: { select: { name: true } },
        ...(userId
          ? { favoritedBy: { where: { id: userId }, select: { id: true } } }
          : {}),
      }
    });
    if (!business) return res.status(404).json({ message: 'Business not found' });
    if (business.status !== 'approved' && (!req.user || business.ownerId !== req.user?.id)) {
      return res.status(404).json({ message: 'Business not found' });
    }
    res.json({
      ...business,
      isFavorite: Array.isArray(business.favoritedBy) && business.favoritedBy.length > 0,
      favoritedBy: undefined,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Booking урсгалд зориулсан public staff жагсаалт
businessRoutes.get('/:id/staff', async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true },
    });
    if (!business || business.status !== 'approved') {
      return res.status(404).json({ message: 'Business not found' });
    }
    const staff = await prisma.staff.findMany({
      where: { businessId: business.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        nickname: true,
        position: true,
        avatar: true,
        bio: true,
        serviceIndexes: true,
        rating: true,
        reviewCount: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(staff);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

businessRoutes.post(
  '/',
  protect,
  [
    body('name').trim().notEmpty(),
    body('category').trim().notEmpty(),
    body('address.city').trim().notEmpty(),
    body('address.country').trim().notEmpty()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const {
        address,
        services = [],
        openingHours = [],
        logoUrl,
        coverUrl,
        gallery = [],
        images: bodyImages,
        ...rest
      } = req.body;
      let businessCode = createBusinessCode();
      for (let i = 0; i < 5; i += 1) {
        const taken = await prisma.business.findUnique({ where: { businessCode } });
        if (!taken) break;
        businessCode = createBusinessCode();
      }
      const fromLegacy = [
        ...(logoUrl ? [String(logoUrl)] : []),
        ...(coverUrl ? [String(coverUrl)] : []),
        ...((Array.isArray(gallery) ? gallery : []).map((x) => String(x)).filter(Boolean)),
      ];
      const mergedImages =
        Array.isArray(bodyImages) && bodyImages.length > 0
          ? bodyImages.map((x) => String(x)).filter(Boolean)
          : fromLegacy;

      const data = {
        ...rest,
        ownerId: req.user.id,
        status: 'pending',
        businessCode,
        addressCity: address?.city,
        addressCountry: address?.country,
        addressStreet: address?.street,
        addressPostal: address?.postalCode,
        latitude: address?.latitude != null && address?.latitude !== '' ? Number(address.latitude) : null,
        longitude: address?.longitude != null && address?.longitude !== '' ? Number(address.longitude) : null,
        services,
        images: mergedImages,
        openingHours
      };

      const business = await prisma.business.create({ data });
      await prisma.businessMember.upsert({
        where: {
          businessId_userId: {
            businessId: business.id,
            userId: req.user.id
          }
        },
        update: {
          role: 'owner',
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: req.user.id
        },
        create: {
          businessId: business.id,
          userId: req.user.id,
          role: 'owner',
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: req.user.id
        }
      });
      res.status(201).json(business);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

businessRoutes.post(
  '/:id/join-requests',
  protect,
  [
    body('role').isIn(['staff', 'manager']).withMessage('role must be staff or manager')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, name: true, ownerId: true }
      });
      if (!business) return res.status(404).json({ message: 'Business not found' });
      if (business.status !== 'approved') {
        return res.status(400).json({ message: 'Зөвхөн approved бизнест хүсэлт илгээнэ' });
      }

      if (business.ownerId === req.user.id) {
        return res.status(400).json({
          message: 'Та энэ бизнесийн эзэмшигч тул ийм хүсэлт илгээх шаардлагагүй',
        });
      }

      if (await userIsApprovedBusinessOwner(req.user.id)) {
        return res.status(403).json({
          message: 'Өөрийн бизнесийн эзэмшигч өөр бизнест нэгдэх хүсэлт илгээх боломжгүй',
        });
      }

      const existingMember = await prisma.businessMember.findUnique({
        where: {
          businessId_userId: {
            businessId: req.params.id,
            userId: req.user.id,
          },
        },
      });
      if (existingMember?.role === 'owner') {
        return res.status(400).json({
          message: 'Та энэ бизнесийн эзэмшигч тул join хүсэлт илгээх боломжгүй',
        });
      }

      const member = await prisma.businessMember.upsert({
        where: {
          businessId_userId: {
            businessId: req.params.id,
            userId: req.user.id
          }
        },
        update: {
          role: req.body.role,
          status: 'pending',
          reviewedAt: null,
          reviewedBy: null
        },
        create: {
          businessId: req.params.id,
          userId: req.user.id,
          role: req.body.role,
          status: 'pending'
        }
      });

      if (business.ownerId && business.ownerId !== req.user.id) {
        const requesterName = req.user?.name || 'Хэрэглэгч';
                const notif = await prisma.notification.create({
          data: {
            userId: business.ownerId,
            title: 'Шинэ join request ирлээ',
            body: `${requesterName} ${business.name} бизнест ${req.body.role} эрхээр хүсэлт илгээлээ.`,
            data: {
              type: 'join_request',
              businessId: business.id,
              requestId: member.id,
              role: req.body.role,
            },
          },
        });
        const devices = await prisma.userDevice.findMany({
          where: { userId: business.ownerId },
          select: { fcmToken: true, fcmApp: true },
        });
        await Promise.all(
          devices.map((dev) => {
            if (!dev.fcmToken) return Promise.resolve();
            return sendFcmMessage(
              dev.fcmToken,
              {
                title: 'Шинэ join request ирлээ',
                body: `${requesterName} хүсэлт илгээлээ`,
              },
              {
                id: notif.id,
                type: 'join_request',
                businessId: business.id,
                requestId: member.id,
                role: req.body.role,
              },
              dev.fcmApp === 'business' ? 'business' : 'consumer',
            );
          }),
        );
      }

      res.status(201).json(member);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

businessRoutes.patch('/:id', protect, async (req, res) => {
  try {
    const business = await prisma.business.findUnique({ where: { id: req.params.id } });
    if (!business) return res.status(404).json({ message: 'Business not found' });
    if (business.ownerId !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this business' });
    }

    const { address, services, openingHours, logoUrl, coverUrl, gallery, images: patchImages, ...rest } = req.body;
    const update = { ...rest };
    if (address) {
      update.addressCity = address.city ?? business.addressCity;
      update.addressCountry = address.country ?? business.addressCountry;
      update.addressStreet = address.street ?? business.addressStreet;
      update.addressPostal = address.postalCode ?? business.addressPostal;
      if (address.latitude != null) update.latitude = Number(address.latitude);
      if (address.longitude != null) update.longitude = Number(address.longitude);
    }
    if (services) update.services = services;
    if (openingHours) update.openingHours = openingHours;
    if (patchImages !== undefined) {
      const bodyImgs = Array.isArray(patchImages) ? patchImages.map((x) => String(x)).filter(Boolean) : [];
      if (bodyImgs.length > 0) update.images = bodyImgs;
    } else if (logoUrl !== undefined || coverUrl !== undefined || gallery !== undefined) {
      const currentImages = Array.isArray(business.images) ? business.images : [];
      const nextLogo = logoUrl !== undefined ? String(logoUrl || '') : (currentImages[0] || '');
      const nextCover = coverUrl !== undefined ? String(coverUrl || '') : (currentImages[1] || '');
      const nextGallery = gallery !== undefined
        ? (Array.isArray(gallery) ? gallery.map((x) => String(x)).filter(Boolean) : [])
        : currentImages.slice(2);
      update.images = [
        ...(nextLogo ? [nextLogo] : []),
        ...(nextCover ? [nextCover] : []),
        ...nextGallery,
      ];
    }

    const updated = await prisma.business.update({
      where: { id: req.params.id },
      data: update
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
