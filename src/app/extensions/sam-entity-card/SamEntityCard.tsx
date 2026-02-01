import React, { useState, useEffect } from 'react';
import {
  hubspot,
  Flex,
  Box,
  Text,
  Heading,
  Button,
  LoadingSpinner,
  Alert,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableHeader,
  Tag,
  Divider,
  Link,
  Tile,
  StatisticTrend,
  DescriptionList,
  DescriptionListItem,
} from '@hubspot/ui-extensions';

// Types for SAM.gov entity data
interface SamEntity {
  uei: string;
  legalBusinessName: string;
  dbaName?: string;
  cageCode?: string;
  registrationStatus: string;
  registrationExpirationDate?: string;
  physicalAddress: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateOrProvinceCode: string;
    zipCode: string;
    countryCode: string;
  };
  mailingAddress?: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateOrProvinceCode: string;
    zipCode: string;
    countryCode: string;
  };
  businessTypes: string[];
  naicsCode?: string[];
  pscCode?: string[];
  sbaBusinessTypes?: string[];
  entityUrl?: string;
  congressionalDistrict?: string;
  entityStructure?: string;
  entityStartDate?: string;
  fiscalYearEndCloseDate?: string;
  activationDate?: string;
}

interface MatchResult {
  entity: SamEntity | null;
  matchScore: number;
  matchStatus: 'matched' | 'pending' | 'no_match' | 'multiple_matches';
  potentialMatches?: SamEntity[];
  subsidiaries?: SamEntity[];
}

hubspot.extend(({ context, runServerlessFunction, actions }) => (
  <SamEntityCard
    context={context}
    runServerlessFunction={runServerlessFunction}
    actions={actions}
  />
));

interface SamEntityCardProps {
  context: any;
  runServerlessFunction: any;
  actions: any;
}

const SamEntityCard: React.FC<SamEntityCardProps> = ({
  context,
  runServerlessFunction,
  actions,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'details' | 'certifications' | 'subsidiaries'>('overview');
  const [refreshing, setRefreshing] = useState(false);

  const companyId = context?.crm?.objectId;

  useEffect(() => {
    if (companyId) {
      fetchSamData();
    }
  }, [companyId]);

  const fetchSamData = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await runServerlessFunction({
        name: 'getSamEntity',
        parameters: { companyId },
      });

      if (response.status === 'SUCCESS') {
        setMatchResult(response.data);
      } else {
        setError(response.message || 'Failed to fetch SAM.gov data');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while fetching data');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const response = await runServerlessFunction({
        name: 'refreshSamEntity',
        parameters: { companyId },
      });

      if (response.status === 'SUCCESS') {
        setMatchResult(response.data);
        actions.addAlert({
          type: 'success',
          message: 'SAM.gov data refreshed successfully',
        });
      } else {
        actions.addAlert({
          type: 'danger',
          message: response.message || 'Failed to refresh data',
        });
      }
    } catch (err: any) {
      actions.addAlert({
        type: 'danger',
        message: err.message || 'An error occurred',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleLinkEntity = async (uei: string) => {
    try {
      const response = await runServerlessFunction({
        name: 'linkSamEntity',
        parameters: { companyId, uei },
      });

      if (response.status === 'SUCCESS') {
        setMatchResult(response.data);
        actions.addAlert({
          type: 'success',
          message: 'Company linked to SAM.gov entity',
        });
      } else {
        actions.addAlert({
          type: 'danger',
          message: response.message || 'Failed to link entity',
        });
      }
    } catch (err: any) {
      actions.addAlert({
        type: 'danger',
        message: err.message || 'An error occurred',
      });
    }
  };

  const handleUnlink = async () => {
    try {
      const response = await runServerlessFunction({
        name: 'unlinkSamEntity',
        parameters: { companyId },
      });

      if (response.status === 'SUCCESS') {
        setMatchResult({ entity: null, matchScore: 0, matchStatus: 'no_match' });
        actions.addAlert({
          type: 'success',
          message: 'Company unlinked from SAM.gov entity',
        });
      }
    } catch (err: any) {
      actions.addAlert({
        type: 'danger',
        message: err.message || 'An error occurred',
      });
    }
  };

  const handleSearchManually = async () => {
    try {
      const response = await runServerlessFunction({
        name: 'searchSamEntities',
        parameters: { companyId },
      });

      if (response.status === 'SUCCESS' && response.data.matches?.length > 0) {
        setMatchResult({
          entity: null,
          matchScore: 0,
          matchStatus: 'multiple_matches',
          potentialMatches: response.data.matches,
        });
      } else {
        actions.addAlert({
          type: 'warning',
          message: 'No matching SAM.gov entities found',
        });
      }
    } catch (err: any) {
      actions.addAlert({
        type: 'danger',
        message: err.message || 'An error occurred during search',
      });
    }
  };

  if (loading) {
    return (
      <Flex direction="column" align="center" justify="center" gap="sm">
        <LoadingSpinner label="Loading SAM.gov data..." />
      </Flex>
    );
  }

  if (error) {
    return (
      <Alert title="Error" variant="danger">
        {error}
        <Button onClick={fetchSamData} variant="secondary" size="sm">
          Retry
        </Button>
      </Alert>
    );
  }

  // No match state
  if (!matchResult?.entity && matchResult?.matchStatus !== 'multiple_matches') {
    return (
      <Flex direction="column" gap="md">
        <Alert title="No SAM.gov Match" variant="warning">
          This company has not been matched to a SAM.gov entity.
        </Alert>
        <Button onClick={handleSearchManually} variant="primary">
          Search SAM.gov
        </Button>
        {matchResult?.subsidiaries && matchResult.subsidiaries.length > 0 && (
          <Box>
            <Heading>Potential Subsidiaries with UEI</Heading>
            <Text variant="microcopy">
              The following entities may be subsidiaries of this company:
            </Text>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader>UEI</TableHeader>
                  <TableHeader>Action</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {matchResult.subsidiaries.map((sub) => (
                  <TableRow key={sub.uei}>
                    <TableCell>{sub.legalBusinessName}</TableCell>
                    <TableCell>{sub.uei}</TableCell>
                    <TableCell>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => handleLinkEntity(sub.uei)}
                      >
                        Link
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
      </Flex>
    );
  }

  // Multiple matches state
  if (matchResult?.matchStatus === 'multiple_matches' && matchResult?.potentialMatches) {
    return (
      <Flex direction="column" gap="md">
        <Alert title="Multiple Matches Found" variant="info">
          Select the correct SAM.gov entity for this company:
        </Alert>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Legal Name</TableHeader>
              <TableHeader>UEI</TableHeader>
              <TableHeader>Location</TableHeader>
              <TableHeader>Score</TableHeader>
              <TableHeader>Action</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {matchResult.potentialMatches.map((match: any) => (
              <TableRow key={match.uei}>
                <TableCell>{match.legalBusinessName}</TableCell>
                <TableCell>
                  <Text format={{ fontWeight: 'demibold' }}>{match.uei}</Text>
                </TableCell>
                <TableCell>
                  {match.physicalAddress?.city}, {match.physicalAddress?.stateOrProvinceCode}
                </TableCell>
                <TableCell>
                  <Tag variant={match.score > 0.8 ? 'success' : match.score > 0.6 ? 'warning' : 'default'}>
                    {Math.round(match.score * 100)}%
                  </Tag>
                </TableCell>
                <TableCell>
                  <Button
                    size="xs"
                    variant="primary"
                    onClick={() => handleLinkEntity(match.uei)}
                  >
                    Select
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Flex>
    );
  }

  const entity = matchResult?.entity;
  if (!entity) return null;

  // Matched entity display
  return (
    <Flex direction="column" gap="md">
      {/* Header with status */}
      <Flex justify="between" align="center">
        <Flex direction="column" gap="xs">
          <Heading>{entity.legalBusinessName}</Heading>
          {entity.dbaName && (
            <Text variant="microcopy">DBA: {entity.dbaName}</Text>
          )}
        </Flex>
        <Flex gap="sm">
          <Tag
            variant={
              entity.registrationStatus === 'Active'
                ? 'success'
                : entity.registrationStatus === 'Inactive'
                ? 'danger'
                : 'warning'
            }
          >
            {entity.registrationStatus}
          </Tag>
          <Button
            size="xs"
            variant="secondary"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        </Flex>
      </Flex>

      {/* Key identifiers */}
      <Flex gap="md" wrap="wrap">
        <Tile>
          <Text variant="microcopy">UEI</Text>
          <Text format={{ fontWeight: 'bold' }}>{entity.uei}</Text>
        </Tile>
        {entity.cageCode && (
          <Tile>
            <Text variant="microcopy">CAGE Code</Text>
            <Text format={{ fontWeight: 'bold' }}>{entity.cageCode}</Text>
          </Tile>
        )}
        {entity.registrationExpirationDate && (
          <Tile>
            <Text variant="microcopy">Registration Expires</Text>
            <Text format={{ fontWeight: 'bold' }}>
              {new Date(entity.registrationExpirationDate).toLocaleDateString()}
            </Text>
          </Tile>
        )}
      </Flex>

      {/* Tab navigation */}
      <Flex gap="sm">
        <Button
          variant={activeTab === 'overview' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </Button>
        <Button
          variant={activeTab === 'details' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setActiveTab('details')}
        >
          Details
        </Button>
        <Button
          variant={activeTab === 'certifications' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setActiveTab('certifications')}
        >
          Certifications
        </Button>
        {matchResult?.subsidiaries && matchResult.subsidiaries.length > 0 && (
          <Button
            variant={activeTab === 'subsidiaries' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTab('subsidiaries')}
          >
            Subsidiaries ({matchResult.subsidiaries.length})
          </Button>
        )}
      </Flex>

      <Divider />

      {/* Tab content */}
      {activeTab === 'overview' && (
        <Flex direction="column" gap="md">
          <DescriptionList direction="row">
            <DescriptionListItem label="Physical Address">
              <Text>
                {entity.physicalAddress.addressLine1}
                {entity.physicalAddress.addressLine2 && <br />}
                {entity.physicalAddress.addressLine2}
                <br />
                {entity.physicalAddress.city}, {entity.physicalAddress.stateOrProvinceCode}{' '}
                {entity.physicalAddress.zipCode}
              </Text>
            </DescriptionListItem>
            {entity.congressionalDistrict && (
              <DescriptionListItem label="Congressional District">
                {entity.congressionalDistrict}
              </DescriptionListItem>
            )}
            {entity.entityStructure && (
              <DescriptionListItem label="Entity Structure">
                {entity.entityStructure}
              </DescriptionListItem>
            )}
          </DescriptionList>

          {entity.businessTypes && entity.businessTypes.length > 0 && (
            <Box>
              <Text variant="microcopy">Business Types</Text>
              <Flex gap="xs" wrap="wrap">
                {entity.businessTypes.map((type, idx) => (
                  <Tag key={idx}>{type}</Tag>
                ))}
              </Flex>
            </Box>
          )}
        </Flex>
      )}

      {activeTab === 'details' && (
        <Flex direction="column" gap="md">
          <DescriptionList direction="row">
            {entity.entityStartDate && (
              <DescriptionListItem label="Entity Start Date">
                {new Date(entity.entityStartDate).toLocaleDateString()}
              </DescriptionListItem>
            )}
            {entity.activationDate && (
              <DescriptionListItem label="SAM Activation Date">
                {new Date(entity.activationDate).toLocaleDateString()}
              </DescriptionListItem>
            )}
            {entity.fiscalYearEndCloseDate && (
              <DescriptionListItem label="Fiscal Year End">
                {entity.fiscalYearEndCloseDate}
              </DescriptionListItem>
            )}
          </DescriptionList>

          {entity.naicsCode && entity.naicsCode.length > 0 && (
            <Box>
              <Text variant="microcopy">NAICS Codes</Text>
              <Flex gap="xs" wrap="wrap">
                {entity.naicsCode.map((code, idx) => (
                  <Tag key={idx} variant="default">
                    {code}
                  </Tag>
                ))}
              </Flex>
            </Box>
          )}

          {entity.pscCode && entity.pscCode.length > 0 && (
            <Box>
              <Text variant="microcopy">PSC Codes</Text>
              <Flex gap="xs" wrap="wrap">
                {entity.pscCode.map((code, idx) => (
                  <Tag key={idx} variant="default">
                    {code}
                  </Tag>
                ))}
              </Flex>
            </Box>
          )}
        </Flex>
      )}

      {activeTab === 'certifications' && (
        <Flex direction="column" gap="md">
          {entity.sbaBusinessTypes && entity.sbaBusinessTypes.length > 0 ? (
            <Box>
              <Text variant="microcopy">SBA Certifications</Text>
              <Flex gap="xs" wrap="wrap">
                {entity.sbaBusinessTypes.map((cert, idx) => (
                  <Tag key={idx} variant="success">
                    {cert}
                  </Tag>
                ))}
              </Flex>
            </Box>
          ) : (
            <Alert title="No Certifications" variant="info">
              No SBA certifications found for this entity.
            </Alert>
          )}
        </Flex>
      )}

      {activeTab === 'subsidiaries' && matchResult?.subsidiaries && (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Name</TableHeader>
              <TableHeader>UEI</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Location</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {matchResult.subsidiaries.map((sub) => (
              <TableRow key={sub.uei}>
                <TableCell>{sub.legalBusinessName}</TableCell>
                <TableCell>{sub.uei}</TableCell>
                <TableCell>
                  <Tag
                    variant={sub.registrationStatus === 'Active' ? 'success' : 'warning'}
                  >
                    {sub.registrationStatus}
                  </Tag>
                </TableCell>
                <TableCell>
                  {sub.physicalAddress?.city}, {sub.physicalAddress?.stateOrProvinceCode}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Actions */}
      <Divider />
      <Flex justify="between">
        {entity.entityUrl && (
          <Link href={entity.entityUrl} external>
            View on SAM.gov
          </Link>
        )}
        <Button variant="destructive" size="xs" onClick={handleUnlink}>
          Unlink Entity
        </Button>
      </Flex>
    </Flex>
  );
};

export default SamEntityCard;
