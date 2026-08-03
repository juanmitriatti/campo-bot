import { useState } from 'react';
import { MapContainer, TileLayer, LayersControl, Marker, Popup, Polygon } from 'react-leaflet';
import type { LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useMapData } from '../../hooks/useMapData';

// Fix default marker icons in leaflet + webpack/vite
import L from 'leaflet';
// @ts-ignore
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  harvested: '#eab308',
  idle: '#9ca3af',
};

export default function FieldMap() {
  const { data, loading } = useMapData();
  const [collapsed, setCollapsed] = useState(false);

  if (loading) return null;
  if (!data || data.fields.length === 0) return null;

  // Find fields with coordinates
  const fieldsWithCoords = data.fields.filter(f => f.lat && f.lng);
  if (fieldsWithCoords.length === 0 && !data.fields.some(f => f.polygon)) return null;

  // Calculate center
  let center: LatLngExpression = [-34, -64]; // Argentina default
  if (fieldsWithCoords.length > 0) {
    const avgLat = fieldsWithCoords.reduce((s, f) => s + f.lat!, 0) / fieldsWithCoords.length;
    const avgLng = fieldsWithCoords.reduce((s, f) => s + f.lng!, 0) / fieldsWithCoords.length;
    center = [avgLat, avgLng];
  }

  // Group plots by field
  const plotsByField = new Map<number, typeof data.plots>();
  for (const plot of data.plots) {
    const list = plotsByField.get(plot.fieldId) || [];
    list.push(plot);
    plotsByField.set(plot.fieldId, list);
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
      >
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Mis campos</h3>
        <span className="text-gray-400 dark:text-gray-300 text-xs">{collapsed ? 'Mostrar' : 'Ocultar'}</span>
      </button>
      {!collapsed && (
        <div style={{ height: window.innerWidth < 768 ? 300 : 400 }}>
          <MapContainer center={center} zoom={8} style={{ height: '100%', width: '100%' }}>
            <LayersControl position="topright">
              {/* Satelital por defecto: el productor reconoce SUS lotes por la imagen, no por calles */}
              <LayersControl.BaseLayer checked name="Satélite">
                <TileLayer
                  attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"
                  url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                />
              </LayersControl.BaseLayer>
              <LayersControl.BaseLayer name="Mapa">
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
              </LayersControl.BaseLayer>
              {/* Nombres de localidades y rutas sobre la imagen satelital */}
              <LayersControl.Overlay checked name="Referencias">
                <TileLayer
                  attribution="Labels &copy; Esri"
                  url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
                />
              </LayersControl.Overlay>
            </LayersControl>
            {fieldsWithCoords.map(field => {
              const fieldPlots = plotsByField.get(field.id) || [];
              return (
                <Marker key={field.id} position={[field.lat!, field.lng!]}>
                  <Popup>
                    <div className="text-sm">
                      <strong>{field.name}</strong>
                      {field.city && <p className="text-gray-500">{field.city}</p>}
                      {fieldPlots.length > 0 && (
                        <ul className="mt-1">
                          {fieldPlots.map(p => (
                            <li key={p.id}>
                              <span style={{ color: STATUS_COLORS[p.cropStatus] }}>&#x25CF;</span>{' '}
                              {p.name}
                              {p.activeCrop && ` (${p.activeCrop})`}
                              {p.areaHectares && ` — ${p.areaHectares} ha`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Popup>
                </Marker>
              );
            })}
            {data.fields
              .filter(f => f.polygon && Array.isArray(f.polygon))
              .map(field => {
                const fieldPlots = plotsByField.get(field.id) || [];
                const mainStatus = fieldPlots.length > 0
                  ? (fieldPlots.some(p => p.cropStatus === 'active') ? 'active'
                     : fieldPlots.some(p => p.cropStatus === 'harvested') ? 'harvested' : 'idle')
                  : 'idle';
                // El polígono viene en DOS formatos según quién lo guardó:
                // [{lat, lng}, ...] (editor web) o [[lat, lng], ...] (bot).
                // Solo objetos crasheaba Leaflet con el formato de pares
                // ([undefined, undefined] → _projectLatlngs TypeError) y el
                // error boundary tumbaba TODO el dashboard.
                const positions = (field.polygon as any[])
                  .map((p: any): [number, number] => Array.isArray(p) ? [p[0], p[1]] : [p?.lat, p?.lng])
                  .filter((pt) => typeof pt[0] === 'number' && typeof pt[1] === 'number' && isFinite(pt[0]) && isFinite(pt[1])) as LatLngExpression[];
                if (positions.length < 3) return null; // sin 3 vértices no hay polígono
                return (
                  <Polygon
                    key={`poly-${field.id}`}
                    positions={positions}
                    pathOptions={{ color: STATUS_COLORS[mainStatus], fillOpacity: 0.2 }}
                  >
                    <Popup>
                      <div className="text-sm">
                        <strong>{field.name}</strong>
                        {fieldPlots.map(p => (
                          <p key={p.id}>
                            {p.name}{p.activeCrop ? ` — ${p.activeCrop}` : ''}
                          </p>
                        ))}
                      </div>
                    </Popup>
                  </Polygon>
                );
              })}
          </MapContainer>
        </div>
      )}
    </div>
  );
}
