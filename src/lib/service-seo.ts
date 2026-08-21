import type { SeoPageDefinition } from "./seo";

export type ServiceSeoContent = SeoPageDefinition & {
  eyebrow: string;
  introduction: string;
  benefits: readonly { title: string; body: string }[];
  process: readonly { title: string; body: string }[];
  idealFor: readonly string[];
  aftercare: string;
  faqs: readonly { question: string; answer: string }[];
  relatedServices: readonly { slug: string; label: string }[];
};

export const SERVICE_SEO: Record<string, ServiceSeoContent> = {
  "interior-detail": {
    title: "Interior Car Detailing Hamilton, ON | Personal Touch",
    description:
      "Deep interior car detailing in Hamilton for carpets, seats, mats, windows and interior surfaces. View pricing and book your vehicle online.",
    path: "/services/interior-detail",
    h1: "Interior car detailing in Hamilton",
    eyebrow: "Interior detailing",
    introduction:
      "Hamilton commutes, winter salt, family use and everyday spills can leave more behind than a quick vacuum can remove. Our interior detail is a methodical reset for the cabin, with the scope and price explained before work begins.",
    benefits: [
      { title: "A deeper cabin clean", body: "Carpets, seats, mats, glass and frequently touched surfaces are worked through in a deliberate sequence." },
      { title: "Condition-aware service", body: "Pet hair, heavy staining and unusual odours are assessed rather than hidden inside a one-size-fits-all promise." },
      { title: "Clear vehicle-size pricing", body: "The booking flow shows the applicable adjustment for SUVs, trucks and vans before you confirm." },
    ],
    process: [
      { title: "Inspect", body: "We confirm the material types, staining, belongings and the areas that matter most to you." },
      { title: "Clean methodically", body: "Loose debris is removed first, followed by the appropriate cleaning of carpets, seats, mats, trim and glass." },
      { title: "Review", body: "The cabin is checked for residue, missed areas and the customer requests recorded at arrival." },
    ],
    idealFor: ["Family vehicles and daily commuters", "Winter salt and carpet buildup", "Vehicles being prepared for sale or return", "Drivers who want a complete cabin reset"],
    aftercare:
      "Allow freshly cleaned fabric to dry fully, keep absorbent mats out until dry, and address new spills promptly rather than letting them set.",
    faqs: [
      { question: "Can every stain be removed?", answer: "No responsible detailer can guarantee that. Results depend on the material, age of the stain and products previously used, so we explain realistic expectations after inspection." },
      { question: "Does the price change for SUVs or trucks?", answer: "Yes. Larger cabins require more time and material, and the applicable size adjustment is shown in the booking flow before confirmation." },
      { question: "Should I remove child seats and belongings?", answer: "Yes. Please remove valuables and personal belongings. Child seats should be removed before arrival because we cannot reinstall them for liability reasons." },
    ],
    relatedServices: [
      { slug: "complete-detail-engine", label: "Complete interior and exterior detail" },
      { slug: "ceramic-coating", label: "Ceramic coating" },
      { slug: "paint-enhancement", label: "Paint enhancement" },
    ],
  },
  "ceramic-coating": {
    title: "Ceramic Coating Hamilton, ON | Personal Touch",
    description:
      "Professional ceramic coating in Hamilton with paint preparation, condition inspection and practical aftercare guidance. Request a vehicle-specific quote.",
    path: "/services/ceramic-coating",
    h1: "Professional ceramic coating in Hamilton",
    eyebrow: "Paint protection",
    introduction:
      "A ceramic coating can make routine washing easier and add durable resistance to environmental contamination, but the result depends on the preparation underneath. We inspect the paint first and quote the preparation and coating together.",
    benefits: [
      { title: "Easier maintenance", body: "A properly maintained hydrophobic surface releases ordinary dirt and water more readily during safe washing." },
      { title: "Prepared, not concealed", body: "Decontamination and any agreed correction happen before coating so defects are not simply sealed underneath." },
      { title: "Hamilton-season protection", body: "The coating adds a sacrificial layer against road film, salt, UV exposure and everyday environmental fallout." },
    ],
    process: [
      { title: "Paint assessment", body: "We inspect condition, previous protection, contamination and the level of correction appropriate for the vehicle." },
      { title: "Preparation", body: "The vehicle is washed, chemically and mechanically decontaminated, dried and polished as agreed in the estimate." },
      { title: "Application and cure", body: "The coating is applied under controlled conditions and given the required initial cure before collection." },
    ],
    idealFor: ["New vehicles that need an easier-care protection plan", "Corrected paint that should retain its finish", "Daily drivers exposed to Hamilton winters", "Owners prepared to follow safe washing and aftercare"],
    aftercare:
      "Avoid washing during the initial cure period stated at pickup. After that, use a pH-appropriate shampoo and safe wash method; periodic maintenance inspections help protect performance.",
    faqs: [
      { question: "Does ceramic coating stop scratches or stone chips?", answer: "No. A coating helps with contamination and maintenance but is not a substitute for paint protection film against physical impacts." },
      { question: "Is paint correction always required?", answer: "Not always. It depends on the paint condition and the result you want. We inspect first so unnecessary correction is not added." },
      { question: "How long does ceramic coating take?", answer: "Preparation, application and cure time vary by vehicle and paint condition. Most coating work requires at least a full day, and the estimate confirms the timing." },
    ],
    relatedServices: [
      { slug: "paint-protection-film", label: "Paint protection film" },
      { slug: "paint-enhancement", label: "Paint enhancement" },
      { slug: "one-stage-correction", label: "One-stage paint correction" },
    ],
  },
  "paint-protection-film": {
    title: "Paint Protection Film (PPF) Hamilton, ON | Personal Touch",
    description:
      "Paint protection film installation in Hamilton for high-impact areas and selected panels. Request a quote based on your vehicle and coverage goals.",
    path: "/services/paint-protection-film",
    h1: "Paint protection film installation in Hamilton",
    eyebrow: "Physical paint protection",
    introduction:
      "Paint protection film is designed for the places that take physical abuse from road debris. Coverage is matched to the vehicle, its current paint condition and how it is driven rather than sold as a generic package.",
    benefits: [
      { title: "Impact-area coverage", body: "Film can protect selected high-exposure panels from ordinary chips, scuffs and road debris." },
      { title: "Vehicle-specific fit", body: "Coverage and installation approach are reviewed for the vehicle’s panel shapes, condition and finish." },
      { title: "Compatible protection plan", body: "PPF can be combined with appropriate coating and maintenance when the products and surfaces are compatible." },
    ],
    process: [
      { title: "Coverage consultation", body: "We identify the areas you want protected and inspect the paint for damage or previous repairs." },
      { title: "Surface preparation", body: "The selected panels are thoroughly cleaned and prepared so contamination is not trapped beneath the film." },
      { title: "Installation and inspection", body: "Film is positioned, finished and inspected before the vehicle is released with care instructions." },
    ],
    idealFor: ["New or recently corrected paint", "Highway-driven vehicles", "High-impact front panels and rocker areas", "Owners prioritizing physical chip protection"],
    aftercare:
      "Follow the initial cure guidance, avoid directing pressure-washer spray at film edges, and use safe washing products. Contact the shop if an edge lifts rather than trimming it yourself.",
    faqs: [
      { question: "Is PPF the same as ceramic coating?", answer: "No. PPF is a physical film intended to absorb minor impacts; ceramic coating is a liquid-applied layer focused on contamination resistance and easier maintenance." },
      { question: "Can PPF be installed over damaged paint?", answer: "Existing chips, failing paint or poor repairs may remain visible or create adhesion concerns. We inspect the vehicle before recommending installation." },
      { question: "Do I need full-vehicle coverage?", answer: "Not necessarily. Many drivers prioritize the front bumper, hood, fenders, mirrors or other high-impact areas based on driving habits and budget." },
    ],
    relatedServices: [
      { slug: "ceramic-coating", label: "Ceramic coating" },
      { slug: "paint-enhancement", label: "Paint enhancement" },
      { slug: "vinyl-wraps", label: "Vinyl vehicle wraps" },
    ],
  },
  "vehicle-tinting": {
    title: "Window Tinting Hamilton, ON | Personal Touch",
    description:
      "Professional automotive window tinting in Hamilton with vehicle-specific film, shade and installation guidance. Request a clear quote for your vehicle.",
    path: "/services/vehicle-tinting",
    h1: "Automotive window tinting in Hamilton",
    eyebrow: "Window tinting",
    introduction:
      "Automotive tint can improve comfort, glare control and appearance when the right film is installed cleanly. We quote by vehicle and window configuration, explain the available options and keep recommendations within applicable Ontario requirements.",
    benefits: [
      { title: "Vehicle-specific recommendation", body: "Film and shade options are discussed around the vehicle, desired appearance and practical use." },
      { title: "Clean preparation", body: "Glass and surrounding areas are prepared carefully to reduce avoidable contamination during installation." },
      { title: "Clear aftercare", body: "You leave knowing when windows can be operated and what normal curing changes may look like." },
    ],
    process: [
      { title: "Confirm the vehicle", body: "We review the glass configuration, existing film, condition and the look or performance you want." },
      { title: "Prepare and install", body: "The glass is cleaned and film is measured, positioned and finished using an appropriate installation process." },
      { title: "Cure and inspect", body: "Edges and visibility are checked, then the curing and cleaning instructions are explained before pickup." },
    ],
    idealFor: ["Drivers seeking glare and heat-management improvements", "Vehicles needing a consistent finished appearance", "Replacement of aged, damaged or poorly installed film", "Owners who want film options explained before choosing"],
    aftercare:
      "Keep the windows closed for the period stated at pickup and avoid cleaning the inside of the glass until initial curing is complete. Use ammonia-free products afterward.",
    faqs: [
      { question: "How long before I can roll the windows down?", answer: "The exact period depends on the film and conditions. We provide the required wait time at pickup; operating the windows too early can damage an uncured edge." },
      { question: "Can you remove old tint first?", answer: "Yes. Tint removal and replacement are quoted based on the film condition, adhesive and vehicle glass configuration." },
      { question: "Will bubbles disappear after installation?", answer: "Some temporary moisture haze or small water pockets can be normal during curing. Contamination or persistent defects are different, so contact us if anything remains after the stated cure period." },
    ],
    relatedServices: [
      { slug: "tint-removal", label: "Tint removal" },
      { slug: "tint-replacement", label: "Tint replacement" },
      { slug: "ceramic-coating", label: "Ceramic coating" },
    ],
  },
};
