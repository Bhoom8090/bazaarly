import { Link } from 'react-router-dom';
import { Product, formatPrice } from '../api';

// Products are drawn as gradient SVG tiles with emoji — no external images required.
export default function ProductTile({ product }: { product: Product }) {
  return (
    <Link to={`/p/${product.productId}`} className="product-card" aria-label={`${product.title}, ${formatPrice(product.price)}`}>
      <div
        className="tile"
        role="img"
        aria-label={`${product.title} illustration`}
        style={{ background: `linear-gradient(140deg, ${product.color} 0%, ${product.color} 55%, rgba(255,255,255,.14) 55.2%, rgba(255,255,255,.14) 100%)` }}
      >
        {product.emoji}
      </div>
      <div className="body">
        <span className="brand">Visit the {product.brand} Store</span>
        <h3>{product.title}</h3>
        <div className="price"><small>₹</small>{formatPrice(product.price).slice(1)}</div>
        <span className="mrp">Inclusive of all taxes</span>
        <span className="availability in">In stock</span>
      </div>
    </Link>
  );
}
