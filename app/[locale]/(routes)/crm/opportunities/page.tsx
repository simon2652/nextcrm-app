import { Suspense } from "react";

import CrmTableSkeleton from "@/components/skeletons/crm-table-skeleton";

import Container from "../../components/ui/Container";
import OpportunitiesView from "../components/OpportunitiesView";
import { getAllCrmData } from "@/actions/crm/get-crm-data";
import { getOpportunitiesFull } from "@/actions/crm/get-opportunities-with-includes";
import { getTranslations } from "next-intl/server";
import { serializeDecimalsList } from "@/lib/serialize-decimals";
import ImportOpportunitiesModal from "@/components/modals/ImportOpportunitiesModal";

const AccountsPage = async () => {
  const t = await getTranslations("CrmPage");
  const crmData = await getAllCrmData();
  const opportunities = serializeDecimalsList(await getOpportunitiesFull());

  return (
    <Container
      title={t("opportunities.pageTitle")}
      description={t("opportunities.pageDescription")}
    >
      <div className="flex justify-end">
        <ImportOpportunitiesModal />
      </div>
      <Suspense fallback={<CrmTableSkeleton />}>
        <OpportunitiesView crmData={crmData} data={opportunities} />
      </Suspense>
    </Container>
  );
};

export default AccountsPage;
