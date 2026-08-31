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
      { slug: "ceramic-coating-crystal", label: "Ceramic coating" },
      { slug: "paint-enhancement", label: "Paint enhancement" },
    ],
  },
  /**
   * Heads the hand-written hub page at /services/ceramic-coating, which
   * compares Crystal, Pro and Max. It is no longer a catalogue service — the
   * three packages are — so this entry exists for the hub's metadata and
   * shared editorial content.
   */
  "ceramic-coating": {
    title: "Ceramic Coating Hamilton, ON | Personal Touch",
    description:
      "Ceramic coating in Hamilton in three packages from $399. Compare Crystal, Pro and Max, see sedan and SUV pricing, and book your vehicle online.",
    path: "/services/ceramic-coating",
    h1: "Ceramic coating packages in Hamilton",
    eyebrow: "Ceramic coating",
    introduction:
      "A ceramic coating adds a durable, hand-applied layer over your paint that makes routine washing easier and resists everyday environmental contamination. We offer three packages so the coating, its expected service life and its warranty can be matched to how long you plan to keep the vehicle.",
    benefits: [
      { title: "Easier maintenance", body: "A properly maintained hydrophobic surface releases ordinary dirt and water more readily during safe washing." },
      { title: "Prepared, not concealed", body: "Decontamination and any agreed correction happen before coating, so defects are not simply sealed underneath." },
      { title: "Hamilton-season protection", body: "The coating adds a sacrificial layer against road film, salt, UV exposure and everyday environmental fallout." },
    ],
    process: [
      { title: "Paint assessment", body: "We inspect condition, previous protection and contamination, and tell you before we start if anything beyond the package price is needed." },
      { title: "Preparation", body: "The vehicle is washed, chemically and mechanically decontaminated and dried ready for application." },
      { title: "Application and cure", body: "The coating is applied by hand, panel by panel, under controlled conditions and given its initial cure before collection." },
    ],
    idealFor: ["New vehicles that need an easier-care protection plan", "Corrected paint that should retain its finish", "Daily drivers exposed to Hamilton winters", "Owners prepared to follow safe washing and aftercare"],
    aftercare:
      "Avoid washing during the initial cure period stated at pickup. After that, use a pH-appropriate shampoo and a safe wash method; periodic maintenance inspections help protect performance and keep a warranty in good standing.",
    faqs: [
      { question: "What is the difference between ceramic protection and ceramic coating?", answer: "Ceramic protection is a single layer of ceramic protection, offered as an add-on to an Ultimate Detail or as a standalone service. Ceramic coating is our full premium coating service, available as the Crystal, Pro and Max packages, with more preparation, a longer service life and, on Pro and Max, a warranty." },
      { question: "Does ceramic coating stop scratches or stone chips?", answer: "No. A coating helps with contamination and maintenance but is not a substitute for paint protection film against physical impacts." },
      { question: "Is paint correction included in the package price?", answer: "No. The package price covers the coating service for your vehicle category. If your paint needs enhancement or correction we quote it separately and wait for your approval before starting it." },
      { question: "Which package comes with a warranty?", answer: "Pro carries a six-year coating warranty and Max carries a ten-year coating warranty. Crystal is offered without a warranty." },
      { question: "How long does the vehicle need to stay with you?", answer: "A coating takes most of a working day, so you book the date rather than a time slot and we contact you to arrange the drop-off. We confirm the collection time with you once we have seen the paint." },
    ],
    relatedServices: [
      { slug: "ceramic-protection", label: "Ceramic protection" },
      { slug: "paint-protection-film", label: "Paint protection film" },
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
      { slug: "ceramic-coating-crystal", label: "Ceramic coating" },
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
      { slug: "ceramic-coating-crystal", label: "Ceramic coating" },
    ],
  },

  /* --- Ceramic protection: ONE layer of ceramic protection, and never
     described or priced as a ceramic coating package. ------------------- */
  "ceramic-protection": {
    title: "Ceramic Protection Hamilton, ON | Personal Touch",
    description:
      "Ceramic protection in Hamilton from $120 when added to an Ultimate Detail, or $199 standalone for a sedan. See vehicle pricing and book online.",
    path: "/services/ceramic-protection",
    h1: "Ceramic protection in Hamilton",
    eyebrow: "Ceramic protection",
    introduction:
      "Ceramic protection is a single layer of ceramic protection applied over clean paint. It is the straightforward way to add water beading and easier washing to a vehicle you are already having detailed, without committing to a full coating package.",
    benefits: [
      { title: "Easier washing, sooner", body: "One layer of ceramic protection helps water and light dirt release during a normal safe wash." },
      { title: "Pairs with a detail", body: "Added to an Ultimate Detail it goes on paint that has just been washed and prepared, which is when it performs best." },
      { title: "A smaller commitment", body: "A single protective layer, priced per vehicle size, for owners not ready for a multi-year coating package." },
    ],
    process: [
      { title: "Clean paint first", body: "Ceramic protection is only applied to washed, dried paint — as part of your detail, or as its own preparation when booked standalone." },
      { title: "Apply the layer", body: "One layer of ceramic protection is applied evenly by hand across the painted panels." },
      { title: "Short cure", body: "The layer is left to set before the vehicle leaves, and we tell you how long to keep it dry." },
    ],
    idealFor: [
      "Anyone booking an Ultimate Detail who wants protection added on the day",
      "Drivers who want easier washing without a multi-year coating",
      "Vehicles being prepared for sale or handover",
      "A first step before deciding on a ceramic coating package",
    ],
    aftercare:
      "Keep the vehicle dry for the period stated at pickup, then wash with a pH-appropriate shampoo and a safe wash method. Ceramic protection is a single layer and is not a substitute for a ceramic coating package.",
    faqs: [
      { question: "Is ceramic protection the same as a ceramic coating?", answer: "No. Ceramic protection is a single layer of ceramic protection. Ceramic coating is our premium multi-package service, with far more preparation, a longer service life and, on Pro and Max, a warranty." },
      { question: "Why is it cheaper with an Ultimate Detail?", answer: "The vehicle has already been washed and prepared as part of that package, so applying the layer takes less additional work. Booked on its own, the preparation has to be done from scratch and it is priced as a standalone service." },
      { question: "Does the price change for an SUV or truck?", answer: "Yes. Larger vehicles have more panel area, and the applicable price for your vehicle category is shown in the booking flow before you confirm." },
    ],
    relatedServices: [
      { slug: "ceramic-coating", label: "Ceramic coating" },
      { slug: "complete-detail-engine", label: "Ultimate Detail" },
      { slug: "paint-protection-film", label: "Paint protection film" },
    ],
  },
  "ceramic-coating-crystal": {
    title: "Crystal Ceramic Coating Hamilton, ON | Personal Touch",
    description:
      "Crystal ceramic coating in Hamilton from $399 for a coupe or sedan. Vehicle wash, paint preparation and coating application. Book online.",
    path: "/services/ceramic-coating-crystal",
    h1: "Crystal ceramic coating in Hamilton",
    eyebrow: "Ceramic coating - Crystal",
    introduction:
      "Crystal is a complete ceramic coating service: a full hand wash, paint preparation and a hand-applied ceramic coating. It is the most direct route to a properly prepared, coated finish.",
    benefits: [
      { title: "A complete coating service", body: "Wash, decontamination, preparation and coating application, all in one booking." },
      { title: "Easier routine washing", body: "A maintained hydrophobic surface releases ordinary dirt and water more readily." },
      { title: "Clear, size-based pricing", body: "The price for your vehicle category is shown before you confirm the booking." },
    ],
    process: [
      { title: "Paint assessment", body: "We look over the paint before starting and tell you if anything beyond the package price is needed, so nothing is added without your approval." },
      { title: "Wash and preparation", body: "The vehicle is washed, decontaminated and dried so the coating bonds to clean paint rather than to road film." },
      { title: "Application and cure", body: "The coating is applied by hand, panel by panel, and given a controlled initial cure before you collect the vehicle." },
    ],
    idealFor: ["Newer vehicles with paint already in good condition", "Owners who want protection without a warranty package", "Drivers looking for easier washing through Hamilton winters", "A first ceramic coating on a well-kept car"],
    aftercare:
      "Keep the vehicle dry for the initial cure period stated at pickup. After that, wash with a pH-appropriate shampoo and a safe wash method; periodic maintenance inspections help the coating perform for its full expected life.",
    faqs: [
      { question: "Does Crystal include a warranty?", answer: "No. Crystal is offered without a warranty. Pro carries a six-year coating warranty and Max carries a ten-year coating warranty." },
      { question: "Is paint correction included?", answer: "No. The price covers the coating service for your vehicle category. If your paint needs enhancement or correction we quote it separately and start only once you approve it." },
      { question: "How does Crystal differ from ceramic protection?", answer: "Ceramic protection is a single layer of ceramic protection added to a detail or booked on its own. Crystal is a full coating service with dedicated preparation and a considerably longer service life." },
    ],
    relatedServices: [
      { slug: "ceramic-coating-pro", label: "Ceramic Coating - Pro" },
      { slug: "ceramic-coating-max", label: "Ceramic Coating - Max" },
      { slug: "ceramic-protection", label: "Ceramic protection" },
    ],
  },
  "ceramic-coating-pro": {
    title: "Pro Ceramic Coating Hamilton, ON | Personal Touch",
    description:
      "Pro ceramic coating in Hamilton from $999 for a coupe or sedan, with a six-year warranty. Higher-grade coating and extra preparation. Book online.",
    path: "/services/ceramic-coating-pro",
    h1: "Pro ceramic coating in Hamilton",
    eyebrow: "Ceramic coating - Pro",
    introduction:
      "Pro uses a higher-grade coating with a longer service life than Crystal, more preparation time before application, and a six-year coating warranty behind the result.",
    benefits: [
      { title: "Six-year warranty", body: "The coating is backed by a six-year warranty, with terms confirmed in writing when you book." },
      { title: "Higher-grade chemistry", body: "A longer-lasting coating than Crystal, for vehicles being kept for years rather than months." },
      { title: "More preparation time", body: "Additional preparation before application, because a coating is only as good as the paint underneath it." },
    ],
    process: [
      { title: "Paint assessment", body: "We look over the paint before starting and tell you if anything beyond the package price is needed, so nothing is added without your approval." },
      { title: "Wash and preparation", body: "The vehicle is washed, decontaminated and dried so the coating bonds to clean paint rather than to road film." },
      { title: "Application and cure", body: "The coating is applied by hand, panel by panel, and given a controlled initial cure before you collect the vehicle." },
    ],
    idealFor: ["Daily drivers being kept for the long term", "Owners who want a warranty behind the coating", "Vehicles that live outside through Hamilton winters", "Paint that has just been corrected and should stay that way"],
    aftercare:
      "Keep the vehicle dry for the initial cure period stated at pickup. After that, wash with a pH-appropriate shampoo and a safe wash method; periodic maintenance inspections help the coating perform for its full expected life.",
    faqs: [
      { question: "How long is the warranty?", answer: "Pro carries a six-year coating warranty. The terms are confirmed in writing when the work is booked, and keeping to the stated aftercare is part of them." },
      { question: "What does Pro add over Crystal?", answer: "A higher-grade coating with a longer service life, additional preparation time before application, an extended cure and the six-year warranty." },
      { question: "Is paint correction included?", answer: "No. The price covers the coating service for your vehicle category. Correction is condition-dependent, quoted separately, and only started once you have approved it." },
    ],
    relatedServices: [
      { slug: "ceramic-coating-max", label: "Ceramic Coating - Max" },
      { slug: "ceramic-coating-crystal", label: "Ceramic Coating - Crystal" },
      { slug: "one-stage-correction", label: "One-stage paint correction" },
    ],
  },
  "ceramic-coating-max": {
    title: "Max Ceramic Coating Hamilton, ON | Personal Touch",
    description:
      "Max ceramic coating in Hamilton from $1,399 for a coupe or sedan, with a premium top layer and a ten-year warranty. Book online.",
    path: "/services/ceramic-coating-max",
    h1: "Max ceramic coating in Hamilton",
    eyebrow: "Ceramic coating - Max",
    introduction:
      "Max is our longest-lasting coating. It uses a premium top layer compared with Pro, our most thorough preparation stage, and carries a ten-year coating warranty.",
    benefits: [
      { title: "Ten-year warranty", body: "Our longest coating warranty, with terms confirmed in writing when you book." },
      { title: "Premium top layer", body: "A premium top layer compared with Pro, for the most durable finish we offer." },
      { title: "Our most thorough preparation", body: "The longest preparation stage of the three packages before any coating is applied." },
    ],
    process: [
      { title: "Paint assessment", body: "We look over the paint before starting and tell you if anything beyond the package price is needed, so nothing is added without your approval." },
      { title: "Wash and preparation", body: "The vehicle is washed, decontaminated and dried so the coating bonds to clean paint rather than to road film." },
      { title: "Application and cure", body: "The coating is applied by hand, panel by panel, and given a controlled initial cure before you collect the vehicle." },
    ],
    idealFor: ["Vehicles being kept for the long term", "Owners who want the most durable finish available", "Newly corrected or newly delivered paint", "Anyone who would rather coat once and maintain it"],
    aftercare:
      "Keep the vehicle dry for the initial cure period stated at pickup. After that, wash with a pH-appropriate shampoo and a safe wash method; periodic maintenance inspections help the coating perform for its full expected life.",
    faqs: [
      { question: "How long is the warranty?", answer: "Max carries a ten-year coating warranty. The terms are confirmed in writing when the work is booked, and keeping to the stated aftercare is part of them." },
      { question: "What does Max add over Pro?", answer: "A premium top layer compared with Pro, our most thorough preparation stage, an extended cure and a ten-year warranty in place of six." },
      { question: "Is paint correction included?", answer: "No. The price covers the coating service for your vehicle category. Correction is condition-dependent, quoted separately, and only started once you have approved it." },
    ],
    relatedServices: [
      { slug: "ceramic-coating-pro", label: "Ceramic Coating - Pro" },
      { slug: "ceramic-coating-crystal", label: "Ceramic Coating - Crystal" },
      { slug: "multi-stage-correction", label: "Multi-stage paint correction" },
    ],
  },
};
