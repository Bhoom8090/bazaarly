'use strict';
// Seed catalogue: 25 products across 6 categories, emoji + gradient colour art,
// prices in paise (GST-inclusive). One product is tagged LOW_STOCK and one OUT_OF_STOCK
// via SKU constants consumed by the inventory seeder.

const CATEGORIES = ['Electronics', 'Books', 'Home & Kitchen', 'Fashion', 'Toys & Games', 'Sports & Fitness'];

const LOW_STOCK_SKU = 'BZ-ELEC-0001';
const OUT_OF_STOCK_SKU = 'BZ-BOOK-0002';

const SEED_PRODUCTS = [
  // Electronics
  { _id: 'p_0001', sku: 'BZ-ELEC-0001', title: 'Wireless Noise-Cancelling Headphones', brand: 'SonicWave', category: 'Electronics', description: 'Over-ear Bluetooth headphones with 30h battery, ANC and deep bass.', price: 899900, currency: 'INR', emoji: '🎧', color: '#1f3b57', status: 'active', version: 1 },
  { _id: 'p_0002', sku: 'BZ-ELEC-0002', title: 'Smart LED TV 43" 4K', brand: 'VistaView', category: 'Electronics', description: '4K Ultra HD smart TV with Android TV, HDR10 and Dolby Audio.', price: 3299900, currency: 'INR', emoji: '📺', color: '#0f2027', status: 'active', version: 1 },
  { _id: 'p_0003', sku: 'BZ-ELEC-0003', title: 'Power Bank 20000mAh Fast Charge', brand: 'VoltEdge', category: 'Electronics', description: 'Dual USB output, 22.5W PD fast charging, LED display.', price: 149900, currency: 'INR', emoji: '🔋', color: '#373b44', status: 'active', version: 1 },
  { _id: 'p_0004', sku: 'BZ-ELEC-0004', title: 'Bluetooth Mechanical Keyboard', brand: 'KeyCraft', category: 'Electronics', description: 'Hot-swappable switches, RGB backlight, tri-mode connectivity.', price: 549900, currency: 'INR', emoji: '⌨️', color: '#232526', status: 'active', version: 1 },
  { _id: 'p_0005', sku: 'BZ-ELEC-0005', title: 'Fitness Smartwatch Pro', brand: 'PulseTech', category: 'Electronics', description: 'AMOLED display, SpO2, HR, GPS and 10-day battery.', price: 699900, currency: 'INR', emoji: '⌚', color: '#141e30', status: 'active', version: 1 },
  // Books
  { _id: 'p_0006', sku: 'BZ-BOOK-0001', title: 'The Pragmatic Programmer', brand: 'Addison-Wesley', category: 'Books', description: 'Classic software craftsmanship guide. 20th anniversary edition.', price: 299900, currency: 'INR', emoji: '📘', color: '#3a1c71', status: 'active', version: 1 },
  { _id: 'p_0007', sku: 'BZ-BOOK-0002', title: 'Atomic Habits', brand: 'Avery', category: 'Books', description: 'Tiny changes, remarkable results — James Clear.', price: 49900, currency: 'INR', emoji: '📗', color: '#134e5e', status: 'active', version: 1 },
  { _id: 'p_0008', sku: 'BZ-BOOK-0003', title: 'Designing Data-Intensive Applications', brand: 'O’Reilly', category: 'Books', description: 'The big ideas behind reliable, scalable systems.', price: 399900, currency: 'INR', emoji: '📙', color: '#42275a', status: 'active', version: 1 },
  { _id: 'p_0009', sku: 'BZ-BOOK-0004', title: 'Ikigai', brand: 'Penguin', category: 'Books', description: 'The Japanese secret to a long and happy life.', price: 25000, currency: 'INR', emoji: '📕', color: '#603813', status: 'active', version: 1 },
  // Home & Kitchen
  { _id: 'p_0010', sku: 'BZ-HOME-0001', title: 'Non-Stick Cookware Set (5 pc)', brand: 'HomeChef', category: 'Home & Kitchen', description: 'Induction-friendly, granite non-stick kadhai, pan and saucepans.', price: 249900, currency: 'INR', emoji: '🍳', color: '#4b5320', status: 'active', version: 1 },
  { _id: 'p_0011', sku: 'BZ-HOME-0002', title: 'Air Fryer 5L Digital', brand: 'CrispPro', category: 'Home & Kitchen', description: 'Oil-free frying, 8 presets, touch panel, 1500W.', price: 799900, currency: 'INR', emoji: '🍟', color: '#7f4f24', status: 'active', version: 1 },
  { _id: 'p_0012', sku: 'BZ-HOME-0003', title: 'Memory Foam Pillow (2 pc)', brand: 'SleepWell', category: 'Home & Kitchen', description: 'Cervical support, breathable cover, hotel comfort.', price: 129900, currency: 'INR', emoji: '🛌', color: '#0f3443', status: 'active', version: 1 },
  { _id: 'p_0013', sku: 'BZ-HOME-0004', title: 'Steel Bottle 1L with Strainer', brand: 'PureSip', category: 'Home & Kitchen', description: 'Insulated, keeps water cool 24h, built-in tea strainer.', price: 69900, currency: 'INR', emoji: '🍶', color: '#355c7d', status: 'active', version: 1 },
  // Fashion
  { _id: 'p_0014', sku: 'BZ-FASH-0001', title: 'Slim-Fit Chinos (Beige)', brand: 'UrbanThread', category: 'Fashion', description: 'Stretch cotton chino trousers, tapered fit.', price: 159900, currency: 'INR', emoji: '👖', color: '#614385', status: 'active', version: 1 },
  { _id: 'p_0015', sku: 'BZ-FASH-0002', title: 'Running Shoes AirZoom', brand: 'SpeedStep', category: 'Fashion', description: 'Lightweight mesh, responsive cushioning. Sizes UK 6–12.', price: 399900, currency: 'INR', emoji: '👟', color: '#2c3e50', status: 'active', version: 1 },
  { _id: 'p_0016', sku: 'BZ-FASH-0003', title: 'Cotton Crew-Neck T-Shirt (Pack of 3)', brand: 'UrbanThread', category: 'Fashion', description: '180 GSM combed cotton, regular fit. Navy/Black/White.', price: 99900, currency: 'INR', emoji: '👕', color: '#16222a', status: 'active', version: 1 },
  { _id: 'p_0017', sku: 'BZ-FASH-0004', title: 'Polarized Aviator Sunglasses', brand: 'SunFrame', category: 'Fashion', description: 'UV400 polarized lenses, metal frame, hard case included.', price: 129900, currency: 'INR', emoji: '🕶️', color: '#3d3d3d', status: 'active', version: 1 },
  // Toys & Games
  { _id: 'p_0018', sku: 'BZ-TOYS-0001', title: 'STEM Robotics Kit (Advanced)', brand: 'BrainyBots', category: 'Toys & Games', description: 'Build 12 robots, coding via app, ages 10+.', price: 349900, currency: 'INR', emoji: '🤖', color: '#1e3c72', status: 'active', version: 1 },
  { _id: 'p_0019', sku: 'BZ-TOYS-0002', title: '1000-Piece Jigsaw Puzzle', brand: 'MindPuzzle', category: 'Toys & Games', description: 'Himalayas panorama. Finished size 68 x 48 cm.', price: 59900, currency: 'INR', emoji: '🧩', color: '#4568dc', status: 'active', version: 1 },
  { _id: 'p_0020', sku: 'BZ-TOYS-0003', title: 'Remote-Control Stunt Car', brand: 'TurboToys', category: 'Toys & Games', description: '4WD, 360° flips, rechargeable, 2.4GHz control.', price: 189900, currency: 'INR', emoji: '🚗', color: '#8e2de2', status: 'active', version: 1 },
  // Sports & Fitness
  { _id: 'p_0021', sku: 'BZ-SPRT-0001', title: 'Anti-Burst Yoga Mat 6mm', brand: 'ZenFlex', category: 'Sports & Fitness', description: 'Non-slip TPE, alignment lines, carry strap included.', price: 79900, currency: 'INR', emoji: '🧘', color: '#136a8a', status: 'active', version: 1 },
  { _id: 'p_0022', sku: 'BZ-SPRT-0002', title: 'Adjustable Dumbbell 24kg', brand: 'IronCore', category: 'Sports & Fitness', description: 'Dial-adjust 2–24kg, replaces 15 dumbbells.', price: 1199900, currency: 'INR', emoji: '🏋️', color: '#232526', status: 'active', version: 1 },
  { _id: 'p_0023', sku: 'BZ-SPRT-0003', title: 'Badminton Racquet (Pack of 2)', brand: 'ShuttlePro', category: 'Sports & Fitness', description: 'Graphite frame, pre-strung, with 3 feather shuttlecocks.', price: 149900, currency: 'INR', emoji: '🏸', color: '#0ba360', status: 'active', version: 1 },
  { _id: 'p_0024', sku: 'BZ-SPRT-0004', title: 'Insulated Sports Bottle 750ml', brand: 'HydraSport', category: 'Sports & Fitness', description: 'BPA-free, splashproof flip cap, wide mouth.', price: 49900, currency: 'INR', emoji: '🥤', color: '#11998e', status: 'active', version: 1 },
  { _id: 'p_0025', sku: 'BZ-SPRT-0005', title: 'Resistance Band Set (5 levels)', brand: 'ZenFlex', category: 'Sports & Fitness', description: 'Stackable 10–50 lbs, ankle straps and door anchor.', price: 89900, currency: 'INR', emoji: '💪', color: '#5b247a', status: 'active', version: 1 },
];

module.exports = { SEED_PRODUCTS, CATEGORIES, LOW_STOCK_SKU, OUT_OF_STOCK_SKU };
